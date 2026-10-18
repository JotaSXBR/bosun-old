// Integration test — requires Postgres with migrations applied.
// Ticket actions / views / outbound: the write surface of multi-atendimento.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import {
  pickupConversation,
  resolveConversation,
  resumeTicket,
  setConversationInProgress,
  setConversationWaiting,
  transferConversation,
} from "./actions";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent, listTenantConversations } from "./service";

const {
  channelConnections,
  conversations,
  messages,
  organizationMembers,
  organizations,
  teams,
  users,
} = schema;

let db: Database;
let orgA: string;
let userId: string;
let agent2: string;
let outsider: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

/** Ingests one inbound on connA/orgA and returns the resulting active ticket. */
async function newTicket(channelUserId: string, messageId: string, timestamp: Date) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Act" },
        content: { type: "text", text: "hi" },
        timestamp,
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.externalId, channelUserId),
          sql`${conversations.status} != 'resolved'`,
        ),
      );
    return conv!;
  });
}

beforeAll(async () => {
  const env = getServerEnv();
  db = createDb(env.database.url);
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }

  const suffix = crypto.randomUUID().slice(0, 8);
  const inserted = await db
    .insert(users)
    .values([
      { name: "IT User", email: `it-act-${suffix}@crm.local` },
      { name: "IT Agent2", email: `it-act2-${suffix}@crm.local` },
      { name: "IT Outsider", email: `it-out-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  userId = inserted[0]!.id;
  agent2 = inserted[1]!.id;
  outsider = inserted[2]!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Act IT A", slug: `act-a-${suffix}` })
    .returning({ id: organizations.id });
  orgA = org!.id;
  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId, role: "agent" },
    { organizationId: orgA, userId: agent2, role: "agent" },
  ]);
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-act-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} = ${orgA}`);
  await db.delete(users).where(sql`${users.id} in (${userId}, ${agent2}, ${outsider})`);
  await db.$client.end();
});

describe("ticket actions", () => {
  it("pickup claims the ticket for the acting agent", async () => {
    const ticket = await newTicket("act-1@c.us", "false_act1@c.us_1", new Date("2024-03-01"));
    const updated = await pickupConversation(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
      },
    });
    expect(updated.status).toBe("in_progress");
    expect(updated.assigneeId).toBe(userId);
  });

  it("pickup refuses a ticket assigned to another agent — transfer is the path", async () => {
    const ticket = await newTicket(
      "act-1b@c.us",
      "false_act1b@c.us_1",
      new Date("2024-03-01T12:00:00Z"),
    );
    await transferConversation(db, ctx(orgA, "manager"), {
      conversationId: ticket.id,
      assigneeId: agent2,
    });
    // A second agent can't silently take over — ownership changes via transfer.
    await expect(
      pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } }),
    ).rejects.toThrowError(/TICKET_ASSIGNED|transfer/i);
    // The assignee re-picking is idempotent, not a takeover.
    const same = await pickupConversation(
      db,
      { ...ctx(orgA, "agent"), userId: agent2 },
      {
        input: {
          conversationId: ticket.id,
        },
      },
    );
    expect(same.assigneeId).toBe(agent2);
  });

  it("transfer to member assigns + in_progress; to team queues it (open, unassigned)", async () => {
    const ticket = await newTicket("act-2@c.us", "false_act2@c.us_1", new Date("2024-03-02"));

    const toUser = await transferConversation(db, ctx(orgA, "manager"), {
      conversationId: ticket.id,
      assigneeId: agent2,
    });
    expect(toUser.assigneeId).toBe(agent2);
    expect(toUser.status).toBe("in_progress");

    // The handoff is documented in the ticket timeline — private, invisible
    // to the customer (never hits the provider).
    const trail = await withTenant(db, orgA, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, ticket.id), eq(messages.private, true))),
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]!.authorId).toBe(userId);
    expect((trail[0]!.metadata as { system?: string }).system).toBe("transfer");
    expect((trail[0]!.metadata as { toAssigneeId?: string }).toAssigneeId).toBe(agent2);

    const teamName = `Act ${crypto.randomUUID().slice(0, 6)}`;
    const teamId = await withTenant(db, orgA, async (tx) => {
      const [team] = await tx
        .insert(teams)
        .values({ organizationId: orgA, name: teamName })
        .returning({ id: teams.id });
      return team!.id;
    });
    const toTeam = await transferConversation(db, ctx(orgA, "manager"), {
      conversationId: ticket.id,
      sectorId: teamId,
    });
    expect(toTeam.sectorId).toBe(teamId);
    expect(toTeam.assigneeId).toBeNull();
    expect(toTeam.status).toBe("open");
    const queueRows = await listTenantConversations(db, ctx(orgA, "manager"), { view: "queue" });
    expect(queueRows.find((c) => c.id === ticket.id)?.sectorName).toBe(teamName);
  });

  it("transfer rejects a non-member target and an unknown team", async () => {
    const ticket = await newTicket("act-3@c.us", "false_act3@c.us_1", new Date("2024-03-03"));
    await expect(
      transferConversation(db, ctx(orgA, "admin"), {
        conversationId: ticket.id,
        assigneeId: outsider,
      }),
    ).rejects.toThrowError(DomainError);
    await expect(
      transferConversation(db, ctx(orgA, "admin"), {
        conversationId: ticket.id,
        sectorId: crypto.randomUUID(),
      }),
    ).rejects.toThrowError(DomainError); // NotFoundError extends DomainError
  });

  it("resolve is terminal: sets resolved_at and rejects further actions", async () => {
    const ticket = await newTicket("act-4@c.us", "false_act4@c.us_1", new Date("2024-03-04"));
    const resolved = await resolveConversation(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
      },
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();

    for (const action of [
      (input: { conversationId: string }) => pickupConversation(db, ctx(orgA, "agent"), { input }),
      (input: { conversationId: string }) => setConversationWaiting(db, ctx(orgA, "agent"), input),
      (input: { conversationId: string }) =>
        setConversationInProgress(db, ctx(orgA, "agent"), input),
    ]) {
      await expect(action({ conversationId: ticket.id })).rejects.toThrowError(
        /immutable|TICKET_RESOLVED/i,
      );
    }
  });

  it("waiting/in_progress cycle works on an active ticket", async () => {
    const ticket = await newTicket("act-5@c.us", "false_act5@c.us_1", new Date("2024-03-05"));
    const waiting = await setConversationWaiting(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    expect(waiting.status).toBe("waiting_customer");
    const back = await setConversationInProgress(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    expect(back.status).toBe("in_progress");
  });

  it("viewer is read-only — write actions throw AuthorizationError", async () => {
    const ticket = await newTicket("act-6@c.us", "false_act6@c.us_1", new Date("2024-03-06"));
    await expect(
      pickupConversation(db, ctx(orgA, "viewer"), { input: { conversationId: ticket.id } }),
    ).rejects.toThrowError(AuthorizationError);
    await expect(
      resolveConversation(db, ctx(orgA, "viewer"), { input: { conversationId: ticket.id } }),
    ).rejects.toThrowError(AuthorizationError);
  });
});

describe("inbox views", () => {
  it("queue = open+unassigned, oldest waiting first; mine/resolved filter", async () => {
    const older = await withTenant(db, orgA, async (tx) => {
      await ingestChannelEvent(tx, connA, {
        event: {
          type: "message.received",
          externalMessageId: "false_q1@c.us_1",
          from: { channelUserId: "q-1@c.us", displayName: "Q1" },
          content: { type: "text", text: "hi" },
          timestamp: new Date("2024-03-10T00:00:00Z"),
        },
      });
      const [c] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "q-1@c.us"));
      return c!;
    });
    const claimed = await withTenant(db, orgA, async (tx) => {
      await ingestChannelEvent(tx, connA, {
        event: {
          type: "message.received",
          externalMessageId: "false_q2@c.us_1",
          from: { channelUserId: "q-2@c.us", displayName: "Q2" },
          content: { type: "text", text: "hi" },
          timestamp: new Date("2024-03-11T00:00:00Z"),
        },
      });
      const [c] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "q-2@c.us"));
      return c!;
    });
    await pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: claimed.id } });

    const queue = await listTenantConversations(db, ctx(orgA, "agent"), { view: "queue" });
    expect(queue.every((c) => c.status === "open" && c.assigneeId === null)).toBe(true);
    expect(queue.map((c) => c.id)).not.toContain(claimed.id);
    // Strictly ascending wait time — whoever waited longest comes first.
    const times = queue.map((c) => c.lastMessageAt?.getTime() ?? 0);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(queue.map((c) => c.id)).toContain(older.id);

    const mine = await listTenantConversations(db, ctx(orgA, "agent"), { view: "mine" });
    expect(mine.every((c) => c.assigneeId === userId && c.status !== "resolved")).toBe(true);
    expect(mine.map((c) => c.id)).toContain(claimed.id);
    expect(mine.find((c) => c.id === claimed.id)?.assigneeName).toBe("IT User");

    const resolved = await listTenantConversations(db, ctx(orgA, "agent"), { view: "closed" });
    expect(resolved.every((c) => c.status === "resolved")).toBe(true);
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe("resumeTicket", () => {
  it("resumeTicket creates an in_progress follow-up assigned to the caller", async () => {
    const ticket = await newTicket("res-1@c.us", "false_r1@c.us_1", new Date("2024-04-06"));
    const resolved = await resolveConversation(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
      },
    });

    const follow = await resumeTicket(db, ctx(orgA, "agent"), { conversationId: resolved.id });
    expect(follow.id).not.toBe(resolved.id);
    expect(follow.precededById).toBe(resolved.id);
    expect(follow.status).toBe("in_progress");
    expect(follow.assigneeId).toBe(userId);
    expect(follow.sectorId).toBeNull();
    expect(follow.ticketSeq).toBe(resolved.ticketSeq + 1);
    expect(follow.ticketNumber).toBe(resolved.ticketNumber + 1);

    // And the source stays resolved — immutable history.
    await expect(
      resumeTicket(db, ctx(orgA, "agent"), { conversationId: follow.id }),
    ).rejects.toThrowError(/TICKET_NOT_RESOLVED|still active/i);
  });
});

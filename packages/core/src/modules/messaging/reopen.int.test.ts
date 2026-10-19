// Integration test — requires Postgres with migrations applied.
// reopenTicket: the "closed by accident" undo — windowed, guarded, audited.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthorizationError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { pickupConversation, reopenTicket, resolveConversation, resumeTicket } from "./actions";
import type * as repository from "./repository";
import { findActiveTicket } from "./repository";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

// Spy over the repository so the race-window branch (check passes, then a
// committed follow-up makes the update hit the unique index) can be staged
// deterministically. Default calls delegate to the real implementation.
vi.mock("./repository", async (importOriginal) => {
  const mod = await importOriginal<typeof repository>();
  return { ...mod, findActiveTicket: vi.fn(mod.findActiveTicket) };
});

const { channelConnections, conversations, organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let userId: string;
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
          sql`${conversations.status} not in ('resolved', 'closed')`,
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
  const [user] = await db
    .insert(users)
    .values({ name: "IT Reopen", email: `it-reopen-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Reopen IT A", slug: `reopen-a-${suffix}` })
    .returning({ id: organizations.id });
  orgA = org!.id;
  await db.insert(organizationMembers).values({ organizationId: orgA, userId, role: "agent" });
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-reopen-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} = ${orgA}`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("reopenTicket", () => {
  it("undoes a resolution inside the window — same ticket, assignee kept", async () => {
    const ticket = await newTicket("re-1@c.us", "false_re1@c.us_1", new Date("2024-04-07"));
    await pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    const resolved = await resolveConversation(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
      },
    });
    expect(resolved.resolvedById).toBe(userId);

    const reopened = await reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id });
    expect(reopened.id).toBe(ticket.id); // same ticket — numbering unchanged
    expect(reopened.ticketNumber).toBe(resolved.ticketNumber);
    expect(reopened.ticketSeq).toBe(resolved.ticketSeq);
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.resolvedById).toBeNull();
    // resolve kept the assignee → lands back in_progress, not the queue.
    expect(reopened.status).toBe("in_progress");
    expect(reopened.assigneeId).toBe(userId);
  });

  it("unassigned ticket reopens to the queue (open), not in_progress", async () => {
    const ticket = await newTicket("re-1b@c.us", "false_re1b@c.us_1", new Date("2024-04-07"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } }); // no pickup — never assigned
    const reopened = await reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id });
    expect(reopened.status).toBe("open");
    expect(reopened.assigneeId).toBeNull();
  });

  it("rejects when the reopen window expired (ticket is effectively closed)", async () => {
    const ticket = await newTicket("re-2@c.us", "false_re2@c.us_1", new Date("2024-04-08"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    // Simulate a resolution older than the default 48h window.
    await withTenant(db, orgA, (tx) =>
      tx
        .update(conversations)
        .set({ resolvedAt: new Date(Date.now() - 72 * 3_600_000) })
        .where(eq(conversations.id, ticket.id)),
    );

    await expect(
      reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id }),
    ).rejects.toThrowError(/REOPEN_WINDOW_EXPIRED|window expired/i);
  });

  it("rejects when a follow-up ticket is already active for the chat", async () => {
    const ticket = await newTicket("re-3@c.us", "false_re3@c.us_1", new Date("2024-04-09"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    await resumeTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id });

    await expect(
      reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id }),
    ).rejects.toThrowError(/ACTIVE_TICKET_EXISTS|follow-up/i);
  });

  it("maps a late-arriving unique violation (drizzle-wrapped) to ACTIVE_TICKET_EXISTS", async () => {
    const ticket = await newTicket("re-3b@c.us", "false_re3b@c.us_1", new Date("2024-04-09"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    await resumeTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id });

    // Stage the race: the pre-check sees "no active ticket", then the update
    // hits the partial unique index — the pg error arrives inside
    // DrizzleQueryError.cause, not on the thrown error itself.
    vi.mocked(findActiveTicket).mockResolvedValueOnce(undefined);

    await expect(
      reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id }),
    ).rejects.toMatchObject({ code: "ACTIVE_TICKET_EXISTS" });
    // The resolved ticket is untouched — the transaction rolled back.
    const after = await withTenant(db, orgA, (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, ticket.id)),
    );
    expect(after[0]!.status).toBe("resolved");
  });

  it("rejects non-resolved tickets and viewers", async () => {
    const ticket = await newTicket("re-4@c.us", "false_re4@c.us_1", new Date("2024-04-10"));
    await expect(
      reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket.id }),
    ).rejects.toThrowError(/TICKET_NOT_RESOLVED|Only resolved/i);
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    await expect(
      reopenTicket(db, ctx(orgA, "viewer"), { conversationId: ticket.id }),
    ).rejects.toThrowError(AuthorizationError);
  });

  it("is tenant-isolated — another org cannot see (let alone reopen) the ticket", async () => {
    const ticket = await newTicket("re-5@c.us", "false_re5@c.us_1", new Date("2024-04-11"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    // A foreign org context never resolves the row (RLS) → NotFound, not reopen.
    await expect(
      reopenTicket(db, ctx(crypto.randomUUID(), "agent"), { conversationId: ticket.id }),
    ).rejects.toThrowError(NotFoundError);
  });
});

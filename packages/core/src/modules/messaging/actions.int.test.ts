// Integration test — requires Postgres with migrations applied.
// Ticket actions / views / outbound: the write surface of multi-atendimento.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { Database } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, DomainError } from "../../errors";
import {
  pickupConversation,
  resolveConversation,
  setConversationInProgress,
  setConversationWaiting,
  transferConversation,
} from "./actions";
import { useActionsFixture } from "./actions.fixture";
import { listTenantConversations } from "./service";

const fx = useActionsFixture();
const { ctx, newTicket } = fx;

const { messages, teams } = schema;

let db: Database;
let orgA: string;
let userId: string;
let agent2: string;
let outsider: string;

// Runs after the fixture's own hooks, which create them.
beforeAll(() => {
  db = fx.db();
  orgA = fx.orgA();
  userId = fx.userId();
  agent2 = fx.agent2();
  outsider = fx.outsider();
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

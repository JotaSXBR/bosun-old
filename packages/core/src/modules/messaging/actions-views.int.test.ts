// Integration test — requires Postgres with migrations applied.
// Ticket actions / views / outbound: the write surface of multi-atendimento.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { Database } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { pickupConversation, resolveConversation, resumeTicket } from "./actions";
import { useActionsFixture } from "./actions.fixture";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent, listTenantConversations } from "./service";

const fx = useActionsFixture();
const { ctx, newTicket } = fx;

const { conversations } = schema;

let db: Database;
let orgA: string;
let userId: string;
let connA: ConnectionRef;

// Runs after the fixture's own hooks, which create them.
beforeAll(() => {
  db = fx.db();
  orgA = fx.orgA();
  userId = fx.userId();
  connA = fx.connA();
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

    // Own resolved ticket: this file no longer inherits one from the ticket-actions tests.
    const done = await newTicket("q-3@c.us", "false_q3@c.us_1", new Date("2024-03-12"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: done.id } });

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

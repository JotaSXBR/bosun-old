// Integration test — requires Postgres with migrations applied.
// Inbox workbench views, filters, snooze and per-tab counters.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DomainError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { pickupConversation, resolveConversation, setConversationSnooze } from "./actions";
import { addInternalNote } from "./outbound";
import { insertMessage, updateConversationLastMessage } from "./repository";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent, listConversationCounts, listTenantConversations } from "./service";

const { channelConnections, conversations, organizationMembers, organizations, teams, users } =
  schema;

let db: Database;
let orgA: string;
let userId: string;
let connA: ConnectionRef;
let sectorId: string;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

/** Ingests one inbound on connA/orgA and returns the resulting active ticket. */
async function newTicket(channelUserId: string, displayName: string, timestamp: Date) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: `m-${channelUserId}-${timestamp.getTime()}`,
        from: { channelUserId, displayName },
        content: { type: "text", text: `oi de ${displayName}` },
        timestamp,
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.externalId, channelUserId), eq(conversations.status, "open")))
      .orderBy(sql`${conversations.createdAt} desc`)
      .limit(1);
    return conv!;
  });
}

beforeAll(async () => {
  const env = getServerEnv();
  db = createDb(env.database.url);
  await db.execute(sql`select 1`);

  const suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({ name: "IV User", email: `it-iv-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "IV A", slug: `iv-a-${suffix}` })
    .returning({ id: organizations.id });
  orgA = org!.id;
  await db.insert(organizationMembers).values({ organizationId: orgA, userId, role: "agent" });
  connA = await withTenant(db, orgA, async (tx) => {
    const [team] = await tx
      .insert(teams)
      .values({ organizationId: orgA, name: "Comercial" })
      .returning({ id: teams.id });
    sectorId = team!.id;
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IV WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-iv-${suffix}`,
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

describe("inbox views", () => {
  it("queue shows unassigned open tickets, mine shows the agent's active ones", async () => {
    const queued = await newTicket("v-queue", "Queued", new Date("2024-01-01T10:00:00Z"));
    const mine = await newTicket("v-mine", "Mine", new Date("2024-01-01T11:00:00Z"));
    await pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: mine.id } });

    const agent = ctx(orgA, "agent");
    const queue = await listTenantConversations(db, agent, { view: "queue" });
    const mineList = await listTenantConversations(db, agent, { view: "mine" });

    expect(queue.map((r) => r.id)).toContain(queued.id);
    expect(queue.map((r) => r.id)).not.toContain(mine.id);
    expect(mineList.map((r) => r.id)).toContain(mine.id);
    expect(mineList.map((r) => r.id)).not.toContain(queued.id);
    // Both inbound-last → the awaiting-reply dot.
    expect(queue.find((r) => r.id === queued.id)?.awaitingReply).toBe(true);
  });

  it("closed collects resolved tickets; pending stays empty until intake", async () => {
    const done = await newTicket("v-closed", "Done", new Date("2024-01-02T10:00:00Z"));
    await pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: done.id } });
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: done.id } });

    const agent = ctx(orgA, "agent");
    const closed = await listTenantConversations(db, agent, { view: "closed" });
    const pending = await listTenantConversations(db, agent, { view: "pending" });
    const all = await listTenantConversations(db, agent, { view: "all" });

    expect(closed.map((r) => r.id)).toContain(done.id);
    expect(all.map((r) => r.id)).not.toContain(done.id);
    expect(pending).toEqual([]);
  });

  it("search matches contact name, channel user id and ticket number", async () => {
    const t1 = await newTicket("5511999", "Zuleica", new Date("2024-01-03T10:00:00Z"));
    const agent = ctx(orgA, "agent");

    const byName = await listTenantConversations(db, agent, { view: "all", search: "zulei" });
    const byPhone = await listTenantConversations(db, agent, { view: "all", search: "55119" });
    const byTicket = await listTenantConversations(db, agent, {
      view: "all",
      search: String(t1.ticketNumber),
    });

    for (const list of [byName, byPhone, byTicket]) {
      expect(list.map((r) => r.id)).toContain(t1.id);
    }
  });

  it("awaitingReply filter drops tickets whose last channel message is outbound", async () => {
    const t1 = await newTicket("v-await", "Await", new Date("2024-01-04T10:00:00Z"));
    const agent = ctx(orgA, "agent");
    const before = await listTenantConversations(db, agent, {
      view: "all",
      awaitingReply: true,
    });
    expect(before.map((r) => r.id)).toContain(t1.id);

    // A real outbound send flips the last direction — the write path
    // (insertMessage + updateConversationLastMessage) is mirrored here.
    const sentAt = new Date("2024-01-04T11:00:00Z");
    await withTenant(db, orgA, async (tx) => {
      await insertMessage(tx, {
        organizationId: orgA,
        conversationId: t1.id,
        channelConnectionId: connA.id,
        contactId: null,
        direction: "outbound",
        content: { type: "text", text: "resposta" },
        externalId: null,
        status: "sent",
        sentAt,
        authorId: userId,
        metadata: {},
      });
      await updateConversationLastMessage(tx, t1.id, {
        lastMessageAt: sentAt,
        lastMessage: {
          direction: "outbound",
          preview: "resposta",
        },
      });
    });
    const after = await listTenantConversations(db, agent, {
      view: "all",
      awaitingReply: true,
    });
    expect(after.map((r) => r.id)).not.toContain(t1.id);
    // The unfiltered list keeps it but clears the flag.
    const all = await listTenantConversations(db, agent, { view: "all" });
    expect(all.find((r) => r.id === t1.id)?.awaitingReply).toBe(false);
  });

  it("internal note does not clear awaitingReply nor leak into the preview", async () => {
    const t1 = await newTicket("v-note", "Note", new Date("2024-01-04T12:00:00Z"));
    const agent = ctx(orgA, "agent");
    await pickupConversation(db, agent, { input: { conversationId: t1.id } });
    await addInternalNote(db, agent, {
      conversationId: t1.id,
      text: "nota interna — não deve virar preview",
    });

    const all = await listTenantConversations(db, agent, { view: "all" });
    const row = all.find((r) => r.id === t1.id);
    // Private notes never touch the denormalized last-message fields —
    // aligned with lastMessageAt, which they don't bump either.
    expect(row?.awaitingReply).toBe(true);
    expect(row?.lastMessagePreview).toBe("oi de Note");
  });
});

describe("snooze", () => {
  it("defers a ticket out of work views into snoozed, then resumes", async () => {
    const t1 = await newTicket("v-snooze", "Snoozy", new Date("2024-01-05T10:00:00Z"));
    const agent = ctx(orgA, "agent");
    const until = new Date(Date.now() + 3_600_000);

    await setConversationSnooze(db, agent, { conversationId: t1.id, until });

    const queue = await listTenantConversations(db, agent, { view: "queue" });
    const all = await listTenantConversations(db, agent, { view: "all" });
    const snoozed = await listTenantConversations(db, agent, { view: "snoozed" });
    expect(queue.map((r) => r.id)).not.toContain(t1.id);
    expect(all.map((r) => r.id)).not.toContain(t1.id);
    expect(snoozed.map((r) => r.id)).toContain(t1.id);
    expect(snoozed.find((r) => r.id === t1.id)?.snoozedUntil).toEqual(until);

    // Resume puts it back in the queue.
    await setConversationSnooze(db, agent, { conversationId: t1.id, until: null });
    const queueAfter = await listTenantConversations(db, agent, { view: "queue" });
    const snoozedAfter = await listTenantConversations(db, agent, { view: "snoozed" });
    expect(queueAfter.map((r) => r.id)).toContain(t1.id);
    expect(snoozedAfter.map((r) => r.id)).not.toContain(t1.id);
  });

  it("an expired snooze returns to the queue lazily — no sweep needed", async () => {
    const t1 = await newTicket("v-lazy", "Lazy", new Date("2024-01-06T10:00:00Z"));
    // Write an already-past snooze directly — the view must treat it as active.
    await withTenant(db, orgA, (tx) =>
      tx
        .update(conversations)
        .set({ snoozedUntil: new Date(Date.now() - 60_000) })
        .where(eq(conversations.id, t1.id)),
    );
    const agent = ctx(orgA, "agent");
    const queue = await listTenantConversations(db, agent, { view: "queue" });
    const snoozed = await listTenantConversations(db, agent, { view: "snoozed" });
    expect(queue.map((r) => r.id)).toContain(t1.id);
    expect(snoozed.map((r) => r.id)).not.toContain(t1.id);
  });

  it("rejects a snooze target in the past", async () => {
    const t1 = await newTicket("v-past", "Past", new Date("2024-01-07T10:00:00Z"));
    await expect(
      setConversationSnooze(db, ctx(orgA, "agent"), {
        conversationId: t1.id,
        until: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(DomainError);
  });
});

describe("view counts + sector filter", () => {
  it("counts agree with what each view lists", async () => {
    const agent = ctx(orgA, "agent");
    const counts = await listConversationCounts(db, agent);
    for (const view of ["pending", "queue", "mine", "all", "snoozed", "closed"] as const) {
      const rows = await listTenantConversations(db, agent, { view, limit: 100 });
      expect(counts[view]).toBe(rows.length);
    }
  });

  it("sectorId filter narrows the list to that team's tickets", async () => {
    const t1 = await newTicket("v-sector", "Sectored", new Date("2024-01-08T10:00:00Z"));
    await withTenant(db, orgA, (tx) =>
      tx.update(conversations).set({ sectorId }).where(eq(conversations.id, t1.id)),
    );
    const agent = ctx(orgA, "agent");
    const filtered = await listTenantConversations(db, agent, { view: "all", sectorId });
    expect(filtered.map((r) => r.id)).toContain(t1.id);
    for (const row of filtered) expect(row.sectorId).toBe(sectorId);
  });
});

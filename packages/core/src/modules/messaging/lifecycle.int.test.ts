// Integration test — requires Postgres with migrations applied.
// closeExpiredResolvedTickets: the scheduled sweep that materializes
// `closed` on resolved tickets past the org's reopen window.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { pickupConversation, reopenTicket, resolveConversation, resumeTicket } from "./actions";
import { closeExpiredResolvedTickets } from "./lifecycle";
import { listConversations } from "./reads";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const {
  channelConnections,
  conversations,
  organizationMembers,
  organizations,
  organizationSettings,
  users,
} = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

/** Ingests one inbound on connA and returns the resulting ticket row. */
async function newTicket(channelUserId: string, messageId: string, org: string = orgA) {
  await withTenant(db, org, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Sweep" },
        content: { type: "text", text: "hi" },
        timestamp: new Date("2024-04-07"),
      },
    }),
  );
  return withTenant(db, org, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, channelUserId))
      .orderBy(sql`${conversations.createdAt} desc`)
      .limit(1);
    return conv!;
  });
}

/** Resolves a ticket then backdates resolved_at to control the window age. */
async function resolvedTicket(channelUserId: string, resolvedHoursAgo: number, org = orgA) {
  const ticket = await newTicket(channelUserId, `false_${channelUserId}_1`, org);
  await resolveConversation(db, ctx(org, "agent"), { input: { conversationId: ticket.id } });
  await withTenant(db, org, (tx) =>
    tx
      .update(conversations)
      .set({ resolvedAt: new Date(Date.now() - resolvedHoursAgo * 3_600_000) })
      .where(eq(conversations.id, ticket.id)),
  );
  return ticket.id;
}

async function getTicket(org: string, id: string) {
  return withTenant(db, org, async (tx) => {
    const [row] = await tx.select().from(conversations).where(eq(conversations.id, id));
    return row!;
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
    .values({ name: "IT Sweep", email: `it-sweep-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  for (const [name, slug] of [
    ["Sweep IT A", `sweep-a-${suffix}`],
    ["Sweep IT B", `sweep-b-${suffix}`],
  ] as const) {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug })
      .returning({ id: organizations.id });
    if (name.endsWith("A")) orgA = org!.id;
    else orgB = org!.id;
    await db.insert(organizationMembers).values({ organizationId: org!.id, userId, role: "agent" });
  }
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-sweep-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("closeExpiredResolvedTickets", () => {
  it("closes resolved tickets past the window and keeps fresh ones resolved", async () => {
    const old = await resolvedTicket("sw-1@c.us", 72); // > default 48h
    const fresh = await resolvedTicket("sw-2@c.us", 1); // inside the window

    const closedIds = await closeExpiredResolvedTickets(db);
    expect(closedIds).toContain(old);
    expect(closedIds).not.toContain(fresh);

    expect((await getTicket(orgA, old)).status).toBe("closed");
    expect((await getTicket(orgA, fresh)).status).toBe("resolved");
  });

  it("honors the per-org reopen window", async () => {
    // Org B narrows the window to 1 hour — a 2h-old resolved ticket closes
    // there while a same-age ticket under org A's 48h default stays resolved.
    await withTenant(db, orgB, (tx) =>
      tx.insert(organizationSettings).values({
        organizationId: orgB,
        ticketReopenWindowHours: 1,
      }),
    );
    // connA belongs to orgA; give orgB its own connection for ingest.
    const connB = await withTenant(db, orgB, async (tx) => {
      const [row] = await tx
        .insert(channelConnections)
        .values({
          organizationId: orgB,
          kind: "waha",
          name: "IT WAHA B",
          credentialsEncrypted: "not-used-in-these-tests",
          webhookToken: `tok-sweep-b-${crypto.randomUUID().slice(0, 8)}`,
        })
        .returning();
      return { id: row!.id, organizationId: orgB, kind: row!.kind };
    });
    const ticketB = await withTenant(db, orgB, async (tx) => {
      await ingestChannelEvent(tx, connB, {
        event: {
          type: "message.received",
          externalMessageId: "false_swb@c.us_1",
          from: { channelUserId: "swb@c.us", displayName: "Sweep B" },
          content: { type: "text", text: "hi" },
          timestamp: new Date("2024-04-07"),
        },
      });
      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "swb@c.us"))
        .limit(1);
      return conv!.id;
    });
    await resolveConversation(db, ctx(orgB, "agent"), { input: { conversationId: ticketB } });
    await withTenant(db, orgB, (tx) =>
      tx
        .update(conversations)
        .set({ resolvedAt: new Date(Date.now() - 2 * 3_600_000) })
        .where(eq(conversations.id, ticketB)),
    );
    const ticketA = await resolvedTicket("sw-3@c.us", 2); // orgA default 48h

    await closeExpiredResolvedTickets(db);
    expect((await getTicket(orgB, ticketB)).status).toBe("closed");
    expect((await getTicket(orgA, ticketA)).status).toBe("resolved");
  });
});

describe("closed ticket semantics", () => {
  it("closed chats accept a new inbound as a follow-up ticket", async () => {
    const ticket = await resolvedTicket("sw-4@c.us", 72);
    await closeExpiredResolvedTickets(db);
    expect((await getTicket(orgA, ticket)).status).toBe("closed");

    // The partial unique index excludes closed — a fresh inbound must land.
    const followup = await newTicket("sw-4@c.us", "false_sw4@c.us_2");
    expect(followup.id).not.toBe(ticket);
    expect(followup.status).toBe("open");
    expect(followup.precededById).toBe(ticket);
  });

  it("reopenTicket rejects closed tickets; resumeTicket creates a follow-up", async () => {
    const ticket = await resolvedTicket("sw-5@c.us", 72);
    await closeExpiredResolvedTickets(db);

    await expect(
      reopenTicket(db, ctx(orgA, "agent"), { conversationId: ticket }),
    ).rejects.toThrowError(/TICKET_NOT_RESOLVED|Only resolved/i);

    const followup = await resumeTicket(db, ctx(orgA, "agent"), { conversationId: ticket });
    expect(followup.precededById).toBe(ticket);
    expect(followup.status).toBe("in_progress");
  });

  it("regular write actions reject closed tickets (immutable history)", async () => {
    const ticket = await resolvedTicket("sw-6@c.us", 72);
    await closeExpiredResolvedTickets(db);

    await expect(
      pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket } }),
    ).rejects.toThrowError(/TICKET_RESOLVED|immutable/i);
  });

  it("views: `mine` excludes closed; `resolved` view includes it", async () => {
    const ticket = await newTicket("sw-7@c.us", "false_sw7@c.us_1");
    await pickupConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    await withTenant(db, orgA, (tx) =>
      tx
        .update(conversations)
        .set({ resolvedAt: new Date(Date.now() - 72 * 3_600_000) })
        .where(eq(conversations.id, ticket.id)),
    );
    await closeExpiredResolvedTickets(db);

    const mine = await listConversations(db, orgA, { view: "mine", limit: 50, userId });
    expect(mine.some((row) => row.id === ticket.id)).toBe(false);
    const resolved = await listConversations(db, orgA, { view: "closed", limit: 50, userId });
    const row = resolved.find((r) => r.id === ticket.id);
    expect(row?.status).toBe("closed");
  });
});

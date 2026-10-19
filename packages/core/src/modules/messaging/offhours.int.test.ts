// Integration test — requires Postgres with migrations applied.
// maybeSendOffHoursReply: the system-path auto-reply driven by the
// process-channel-event job — once per conversation per org-local day.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { maybeSendOffHoursReply } from "./offhours";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const {
  channelConnections,
  conversations,
  messages,
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

/** Org open Mon-Fri 09:00–18:00 São Paulo, with an auto-reply template. */
async function configureOffHours(org: string) {
  await withTenant(db, org, (tx) =>
    tx.insert(organizationSettings).values({
      organizationId: org,
      businessHours: {
        windows: { mon: [{ start: "09:00", end: "18:00" }] },
      },
      offHoursMessage: "Fora do expediente. Voltamos {proximo_atendimento}.",
      timezone: "America/Sao_Paulo",
    }),
  );
}

/** Ingests an inbound message and returns the ticket that received it. */
async function inbound(
  org: string,
  conn: ConnectionRef,
  { channelUserId, msgId }: { channelUserId: string; msgId: string },
) {
  await withTenant(db, org, (tx) =>
    ingestChannelEvent(tx, conn, {
      event: {
        type: "message.received",
        externalMessageId: msgId,
        from: { channelUserId, displayName: "Cust" },
        content: { type: "text", text: "oi" },
        timestamp: new Date("2024-04-07"),
      },
    }),
  );
  return withTenant(db, org, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.externalId, channelUserId))
      .limit(1);
    return conv!;
  });
}

async function markerRows(org: string, conversationId: string) {
  return withTenant(db, org, (tx) =>
    tx
      .select()
      .from(messages)
      .where(
        sql`${messages.conversationId} = ${conversationId}
            and ${messages.metadata} ->> 'system' = 'off_hours'`,
      ),
  );
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
    .values({ name: "IT OffHours", email: `it-offhours-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  for (const slug of ["off-a", "off-b"]) {
    const [org] = await db
      .insert(organizations)
      .values({ name: `Off ${slug}`, slug: `${slug}-${suffix}` })
      .returning({ id: organizations.id });
    await db.insert(organizationMembers).values({ organizationId: org!.id, userId, role: "agent" });
    if (slug === "off-a") orgA = org!.id;
    else orgB = org!.id;
  }
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-off-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
  await configureOffHours(orgA);
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

// Sunday 2024-04-07 → outside the Monday-only windows all day.
const sunday = new Date("2024-04-07T15:00:00Z"); // 12:00 SP Sunday

describe("maybeSendOffHoursReply", () => {
  it("sends one reply per conversation per day, marked as system", async () => {
    const conv = await inbound(orgA, connA, {
      channelUserId: "oh-1@c.us",
      msgId: "false_oh1@c.us_1",
    });
    const provider = new FakeChannelProvider();

    const first = await maybeSendOffHoursReply(
      db,
      { organizationId: orgA, conversationId: conv.id, now: sunday },
      { provider },
    );
    expect(first.sent).toBe(true);
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]!.to).toBe("oh-1@c.us");

    // Second call the same org-day → dedup, no new provider call.
    const again = await maybeSendOffHoursReply(
      db,
      { organizationId: orgA, conversationId: conv.id, now: sunday },
      { provider },
    );
    expect(again).toEqual({ sent: false, reason: "already-sent-today" });
    expect(provider.sentMessages).toHaveLength(1);

    const markers = await markerRows(orgA, conv.id);
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    expect(marker.authorId).toBeNull();
    expect(marker.direction).toBe("outbound");
    expect(marker.status).toBe("sent");
    expect((marker.metadata as Record<string, string>).autoReplyDay).toBe("2024-04-07");
    // The ticket is NOT mutated like an agent reply — stays open/unassigned.
    const [row] = await withTenant(db, orgA, (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, conv.id)),
    );
    expect(row!.status).toBe("open");
    expect(row!.assigneeId).toBeNull();
    expect(row!.firstResponseAt).toBeNull();
  });

  it("stays silent inside business hours and when not configured", async () => {
    const within = await inbound(orgA, connA, {
      channelUserId: "oh-2@c.us",
      msgId: "false_oh2@c.us_1",
    });
    const provider = new FakeChannelProvider();
    // Monday 10:00 SP = inside the window.
    const monday10 = new Date("2024-04-08T13:00:00Z");
    const inside = await maybeSendOffHoursReply(
      db,
      { organizationId: orgA, conversationId: within.id, now: monday10 },
      { provider },
    );
    expect(inside).toEqual({ sent: false, reason: "within-hours" });
    expect(provider.sentMessages).toHaveLength(0);

    // Org B never set offHoursMessage → hard no.
    const ticketB = await inbound(orgA, connA, {
      channelUserId: "oh-3@c.us",
      msgId: "false_oh3@c.us_1",
    });
    const noCfg = await maybeSendOffHoursReply(
      db,
      { organizationId: orgB, conversationId: ticketB.id, now: sunday },
      { provider },
    );
    // Cross-tenant id → RLS hides the row → treated as no ticket, never sends.
    expect(noCfg.sent).toBe(false);
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("tenant isolation: org B settings don't leak into org A conversations", async () => {
    await configureOffHours(orgB); // orgB now configured too
    // A conversation of org B on org A's connection cannot exist cross-tenant;
    // assert on the marker count instead: org B has no off-hours replies.
    const convB = await withTenant(db, orgB, async (tx) => {
      const [conn] = await tx
        .insert(channelConnections)
        .values({
          organizationId: orgB,
          kind: "waha",
          name: "B",
          credentialsEncrypted: "x",
          webhookToken: `tok-off-b-${crypto.randomUUID().slice(0, 8)}`,
        })
        .returning();
      await ingestChannelEvent(
        tx,
        { id: conn!.id, organizationId: orgB, kind: conn!.kind },
        {
          event: {
            type: "message.received",
            externalMessageId: "false_ohb@c.us_1",
            from: { channelUserId: "ohb@c.us", displayName: "B" },
            content: { type: "text", text: "oi" },
            timestamp: new Date("2024-04-07"),
          },
        },
      );
      const [c] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "ohb@c.us"))
        .limit(1);
      return c!;
    });
    const provider = new FakeChannelProvider();
    const sent = await maybeSendOffHoursReply(
      db,
      { organizationId: orgB, conversationId: convB.id, now: sunday },
      { provider },
    );
    expect(sent.sent).toBe(true);
    const markersB = await markerRows(orgB, convB.id);
    expect(markersB).toHaveLength(1);
    // org A sees nothing of org B's marker.
    const leak = await withTenant(db, orgA, (tx) =>
      tx.select({ id: messages.id }).from(messages).where(eq(messages.id, markersB[0]!.id)),
    );
    expect(leak).toHaveLength(0);
  });

  it("provider failure marks the marker failed and a retry sends again", async () => {
    const conv = await inbound(orgA, connA, {
      channelUserId: "oh-4@c.us",
      msgId: "false_oh4@c.us_1",
    });
    const failing = new FakeChannelProvider();
    failing.sendMessageError = new Error("provider down");

    await expect(
      maybeSendOffHoursReply(
        db,
        { organizationId: orgA, conversationId: conv.id, now: sunday },
        { provider: failing },
      ),
    ).rejects.toThrow("provider down");
    const failed = await markerRows(orgA, conv.id);
    expect(failed[0]!.status).toBe("failed");

    // Template edited while the marker was failed — the retry sends the
    // CURRENT text and the row mirrors what actually went out.
    await withTenant(db, orgA, (tx) =>
      tx
        .update(organizationSettings)
        .set({ offHoursMessage: "Fechado. {proximo_atendimento}." })
        .where(eq(organizationSettings.organizationId, orgA)),
    );
    const ok = new FakeChannelProvider();
    const retry = await maybeSendOffHoursReply(
      db,
      { organizationId: orgA, conversationId: conv.id, now: sunday },
      { provider: ok },
    );
    expect(retry.sent).toBe(true);
    expect(retry.sent && retry.messageId).toBe(failed[0]!.id);
    const after = await markerRows(orgA, conv.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("sent");
    expect(after[0]!.content).toEqual({ type: "text", text: "Fechado. amanhã às 09:00." });
  });
});

// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { insertMessage } from "./repository";
import type { ConnectionRef } from "./service";
import {
  ingestChannelEvent,
  listConversationMessagesAround,
  searchConversationMessages,
} from "./service";

const { channelConnections, conversations, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

const inbound: ChannelEvent = {
  type: "message.received",
  externalMessageId: "false_rd@c.us_R1",
  from: { channelUserId: "rd@c.us", displayName: "Read" },
  content: { type: "text", text: "hello" },
  timestamp: new Date("2024-05-01T00:00:00Z"),
};

beforeAll(async () => {
  const env = getServerEnv();
  db = createDb(env.database.url);
  const suffix = crypto.randomUUID().slice(0, 8);
  const [user] = await db
    .insert(users)
    .values({ name: "IT Read User", email: `it-rd-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Rd IT A", slug: `rd-a-${suffix}` },
      { name: "Rd IT B", slug: `rd-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;
  const [conn] = await withTenant(db, orgA, async (tx) =>
    tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-rd-${suffix}`,
      })
      .returning(),
  );
  connA = { id: conn!.id, organizationId: orgA, kind: conn!.kind };
  // Seed one inbound so org A has listable data.
  await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event: inbound }));
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("thread search + jump window (B1)", () => {
  async function seedSearchThread(): Promise<string> {
    // Unique contact per call → a fresh conversation per test.
    const channelUserId = `s-${crypto.randomUUID().slice(0, 8)}@c.us`;
    return withTenant(db, orgA, async (tx) => {
      const event: ChannelEvent = {
        type: "message.received",
        externalMessageId: `false_${crypto.randomUUID().slice(0, 8)}`,
        from: { channelUserId, displayName: "Search" },
        content: { type: "text", text: "quero saber o preço do produto" },
        timestamp: new Date("2024-07-01T00:00:00Z"),
      };
      await ingestChannelEvent(tx, connA, { event });
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.externalId, channelUserId))
        .orderBy(sql`${conversations.createdAt} desc`)
        .limit(1);
      for (const i of [1, 2, 3, 4, 5]) {
        await insertMessage(tx, {
          organizationId: orgA,
          conversationId: conv!.id,
          channelConnectionId: connA.id,
          contactId: null,
          direction: "outbound",
          content: { type: "text", text: i === 3 ? "o preço é 100 reais" : `reply ${i}` },
          externalId: `s-${crypto.randomUUID().slice(0, 8)}-${i}`,
          status: "sent",
          sentAt: new Date(`2024-07-01T00:00:0${i}Z`),
        });
      }
      return conv!.id;
    });
  }

  it("finds text in both directions, newest first, and escapes %", async () => {
    const conversationId = await seedSearchThread();
    const hits = await searchConversationMessages(db, ctx(orgA, "agent"), {
      conversationId,
      query: "preço",
    });
    expect(hits.map((h) => h.preview)).toEqual([
      "o preço é 100 reais",
      "quero saber o preço do produto",
    ]);

    // Literal % — a wildcard pattern would return the whole thread.
    const none = await searchConversationMessages(db, ctx(orgA, "agent"), {
      conversationId,
      query: "100%",
    });
    expect(none).toHaveLength(0);
  });

  it("returns a ±radius window around the target, chronological and enriched", async () => {
    const conversationId = await seedSearchThread();
    const [hit] = await searchConversationMessages(db, ctx(orgA, "agent"), {
      conversationId,
      query: "100 reais",
    });
    const rows = await listConversationMessagesAround(db, ctx(orgA, "agent"), {
      conversationId,
      messageId: hit!.id,
      radius: 1,
    });
    expect(rows).toHaveLength(3);
    expect(rows[1]!.id).toBe(hit!.id);
    expect((rows[1]!.content as { text: string }).text).toBe("o preço é 100 reais");
    // Enrichment fields exist on the window rows (reactions/quoted).
    expect(rows[1]!.reactions).toEqual([]);
    expect(rows[1]!).toHaveProperty("quoted");
  });

  it("hides foreign conversations and rejects foreign/cross-org message ids", async () => {
    const conversationId = await seedSearchThread();
    // Org B sees no hits and can't jump into org A's thread.
    const hitsB = await searchConversationMessages(db, ctx(orgB, "admin"), {
      conversationId,
      query: "preço",
    });
    expect(hitsB).toHaveLength(0);
    await expect(
      listConversationMessagesAround(db, ctx(orgB, "admin"), {
        conversationId,
        messageId: crypto.randomUUID(),
      }),
    ).rejects.toThrowError(NotFoundError);
    const [hit] = await searchConversationMessages(db, ctx(orgA, "agent"), {
      conversationId,
      query: "preço",
    });
    await expect(
      listConversationMessagesAround(db, ctx(orgB, "admin"), {
        conversationId,
        messageId: hit!.id,
      }),
    ).rejects.toThrowError(NotFoundError);
  });

  it("redacts revoked content in the window for non-privileged roles", async () => {
    const conversationId = await seedSearchThread();
    const [hit] = await searchConversationMessages(db, ctx(orgA, "agent"), {
      conversationId,
      query: "preço",
    });
    await withTenant(db, orgA, (tx) =>
      tx
        .update(schema.messages)
        .set({ revokedAt: new Date() })
        .where(eq(schema.messages.id, hit!.id)),
    );

    const forAgent = await listConversationMessagesAround(db, ctx(orgA, "agent"), {
      conversationId,
      messageId: hit!.id,
      radius: 1,
    });
    expect(forAgent[1]!.content).toEqual({ type: "text", text: "" });
    const forAdmin = await listConversationMessagesAround(db, ctx(orgA, "admin"), {
      conversationId,
      messageId: hit!.id,
      radius: 1,
    });
    expect((forAdmin[1]!.content as { text: string }).text).toBe("o preço é 100 reais");
  });
});

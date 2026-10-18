// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, contacts, conversations, messages, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;

const messageReceived: ChannelEvent = {
  type: "message.received",
  externalMessageId: "false_1234567890@c.us_ABC123",
  from: { channelUserId: "1234567890@c.us", displayName: "Alice" },
  content: { type: "text", text: "Hello World!" },
  timestamp: new Date("2024-01-01T00:00:00Z"),
};

async function insertConnection(
  organizationId: string,
  webhookToken: string,
): Promise<ConnectionRef> {
  return withTenant(db, organizationId, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken,
      })
      .returning();
    return { id: row!.id, organizationId, kind: row!.kind };
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
    .values({ name: "IT User", email: `it-msg-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Msg IT A", slug: `msg-a-${suffix}` },
      { name: "Msg IT B", slug: `msg-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;
  connA = await insertConnection(orgA, `tok-a-${suffix}`);
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("tenant RLS isolation (messaging tables)", () => {
  it("org B sees none of org A's rows in any of the four tables", async () => {
    await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event: messageReceived }));

    for (const table of [channelConnections, contacts, conversations, messages] as const) {
      const inB = await withTenant(db, orgB, (tx) => tx.select().from(table));
      expect(inB).toHaveLength(0);
      const inA = await withTenant(db, orgA, (tx) => tx.select().from(table));
      expect(inA.length).toBeGreaterThan(0);
      expect(inA.every((r) => r.organizationId === orgA)).toBe(true);
    }
  });

  it("an insert for org A inside an org B context is rejected", async () => {
    const error = await withTenant(db, orgB, (tx) =>
      tx.insert(contacts).values({ organizationId: orgA, channelUserId: "999@c.us" }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    const cause = (error as { cause?: Error }).cause;
    expect(String(cause?.message ?? (error as Error).message)).toMatch(
      /row-level security|row violates/i,
    );
  });
});

describe("ingestChannelEvent", () => {
  it("message.received upserts contact + conversation and inserts the message once", async () => {
    const event: ChannelEvent = {
      type: "message.received",
      externalMessageId: "false_555@c.us_DUP1",
      from: { channelUserId: "555@c.us", displayName: "Bob" },
      content: { type: "text", text: "hi" },
      timestamp: new Date("2024-01-02T00:00:00Z"),
    };

    const first = await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event }));
    expect(first.messageId).not.toBeNull();

    // Replay: same external id → idempotent, still a single message row.
    const replay = await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event }));
    expect(replay.messageId).toBeNull();

    await withTenant(db, orgA, async (tx) => {
      const msgs = await tx
        .select()
        .from(messages)
        .where(eq(messages.externalId, "false_555@c.us_DUP1"));
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.direction).toBe("inbound");
      expect(msgs[0]!.status).toBe("received");
      expect(msgs[0]!.content).toEqual({ type: "text", text: "hi" });

      const [conv] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, msgs[0]!.conversationId));
      expect(conv!.externalId).toBe("555@c.us");
      expect(conv!.lastMessageAt).toEqual(new Date("2024-01-02T00:00:00Z"));

      const [contact] = await tx.select().from(contacts).where(eq(contacts.id, conv!.contactId));
      expect(contact!.channelUserId).toBe("555@c.us");
      expect(contact!.displayName).toBe("Bob");
    });
  });

  it("a second message from the same user reuses contact and conversation", async () => {
    const event: ChannelEvent = {
      type: "message.received",
      externalMessageId: "false_555@c.us_DUP2",
      from: { channelUserId: "555@c.us", displayName: "Bob" },
      content: { type: "text", text: "again" },
      timestamp: new Date("2024-01-03T00:00:00Z"),
    };
    await withTenant(db, orgA, (tx) => ingestChannelEvent(tx, connA, { event }));

    await withTenant(db, orgA, async (tx) => {
      const convs = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.externalId, "555@c.us"));
      expect(convs).toHaveLength(1);
      const msgs = await tx
        .select()
        .from(messages)
        .where(eq(messages.conversationId, convs[0]!.id));
      expect(msgs).toHaveLength(2);
      expect(convs[0]!.lastMessageAt).toEqual(new Date("2024-01-03T00:00:00Z"));
    });
  });

  it("message.status updates the stored message", async () => {
    const result = await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.status",
          externalMessageId: "false_555@c.us_DUP1",
          status: "delivered",
          timestamp: new Date(),
        },
      }),
    );
    expect(result.messageId).not.toBeNull();
    await withTenant(db, orgA, async (tx) => {
      const [msg] = await tx
        .select()
        .from(messages)
        .where(eq(messages.externalId, "false_555@c.us_DUP1"));
      expect(msg!.status).toBe("delivered");
    });
  });

  it("connection.status updates the channel connection", async () => {
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, { event: { type: "connection.status", status: "connected" } }),
    );
    await withTenant(db, orgA, async (tx) => {
      const [conn] = await tx
        .select()
        .from(channelConnections)
        .where(eq(channelConnections.id, connA.id));
      expect(conn!.status).toBe("connected");
      expect(conn!.connectedAt).not.toBeNull();
    });
  });
});

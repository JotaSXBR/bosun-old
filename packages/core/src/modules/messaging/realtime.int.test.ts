// Integration test — real Postgres LISTEN/NOTIFY end to end:
// ingest inside withTenant → pg_notify on commit → subscribeDomainEvents.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { getServerEnv } from "@crm/config";
import type { Database, DomainEvent } from "@crm/db";
import { createDb, domainEventSchema, schema, subscribeDomainEvents, withTenant } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;
let connB: ConnectionRef;

function messageEvent(externalMessageId: string, channelUserId: string): ChannelEvent {
  return {
    type: "message.received",
    externalMessageId,
    from: { channelUserId, displayName: "RT" },
    content: { type: "text", text: "hi" },
    timestamp: new Date("2024-02-01T00:00:00Z"),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEvents(events: DomainEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (events.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${count} domain events (got ${events.length})`);
    }
    await sleep(50);
  }
}

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
        name: "IT RT",
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
    .values({ name: "IT RT User", email: `it-rt-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const orgs = await db
    .insert(organizations)
    .values([
      { name: "RT IT A", slug: `rt-a-${suffix}` },
      { name: "RT IT B", slug: `rt-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;
  connA = await insertConnection(orgA, `tok-rt-a-${suffix}`);
  connB = await insertConnection(orgB, `tok-rt-b-${suffix}`);
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("subscribeDomainEvents + ingestChannelEvent", () => {
  it("delivers message.received to the emitting org's subscribers only", async () => {
    const eventsA: DomainEvent[] = [];
    const unsubscribeA = await subscribeDomainEvents(orgA, (event) => eventsA.push(event));
    try {
      const result = await withTenant(db, orgA, (tx) =>
        ingestChannelEvent(tx, connA, { event: messageEvent("rt_a_1", "rt-111@c.us") }),
      );
      expect(result.messageId).not.toBeNull();

      // A brand-new chat emits conversation.created THEN message.received.
      await waitForEvents(eventsA, 2);
      const created = eventsA.find((e) => e.type === "conversation.created");
      const received = eventsA.find((e) => e.type === "message.received");
      // Payloads arrived as JSON and already survived zod parsing inside the
      // subscription — re-assert the contract here.
      expect(created).toBeDefined();
      expect(created!.organizationId).toBe(orgA);
      expect(created!.ticketNumber).toBeTypeOf("number");
      expect(domainEventSchema.safeParse(received).success).toBe(true);
      expect(received).toMatchObject({
        type: "message.received",
        organizationId: orgA,
        messageId: result.messageId,
        sentAt: "2024-02-01T00:00:00.000Z",
      });
      expect(received!.conversationId).toBeTypeOf("string");
      expect(received!.contactId).toBeTypeOf("string");

      // Idempotent webhook replay: no new row → no new notifications.
      await withTenant(db, orgA, (tx) =>
        ingestChannelEvent(tx, connA, { event: messageEvent("rt_a_1", "rt-111@c.us") }),
      );
      await sleep(500);
      expect(eventsA).toHaveLength(2);

      // Cross-tenant: org B's insert emits on the same channel, but org A's
      // subscriber must filter it out while org B's own subscriber gets it.
      const eventsB: DomainEvent[] = [];
      const unsubscribeB = await subscribeDomainEvents(orgB, (event) => eventsB.push(event));
      try {
        await withTenant(db, orgB, (tx) =>
          ingestChannelEvent(tx, connB, { event: messageEvent("rt_b_1", "rt-222@c.us") }),
        );
        await waitForEvents(eventsB, 2);
        expect(eventsB.every((e) => e.organizationId === orgB)).toBe(true);
        await sleep(500);
        expect(eventsA).toHaveLength(2);
      } finally {
        await unsubscribeB();
      }
    } finally {
      await unsubscribeA();
    }
  });
});

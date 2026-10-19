// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { ChannelEvent } from "@crm/channels";
import { FakeChannelProvider } from "@crm/channels/testing";
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
  getConversationDetail,
  ingestChannelEvent,
  listConversationMessages,
  listTenantConversations,
  markConversationRead,
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

describe("internal notes (messages.private)", () => {
  it("persists the private flag and returns it on reads", async () => {
    const conversationId = await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.externalId, "rd@c.us"));
      await insertMessage(tx, {
        organizationId: orgA,
        conversationId: conv!.id,
        channelConnectionId: connA.id,
        contactId: null,
        direction: "outbound",
        content: { type: "text", text: "nota interna" },
        externalId: null,
        status: "sent",
        sentAt: new Date(),
        private: true,
      });
      return conv!.id;
    });

    const rows = await listConversationMessages(db, ctx(orgA, "agent"), { conversationId });
    const note = rows.find((m) => m.private);
    expect(note?.content).toEqual({ type: "text", text: "nota interna" });
  });
});

describe("messaging reads with tenant context", () => {
  it("lists conversations and messages only for the caller's org", async () => {
    const convs = await listTenantConversations(db, ctx(orgA, "agent"), { limit: 10 });
    expect(convs.length).toBeGreaterThan(0);
    expect(convs.every((c) => c.organizationId === orgA)).toBe(true);

    const msgs = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId: convs[0]!.id,
    });
    expect(msgs.length).toBeGreaterThan(0);

    const convsB = await listTenantConversations(db, ctx(orgB, "admin"), { limit: 10 });
    expect(convsB).toHaveLength(0);

    // Messages of an org A conversation are unreachable from org B.
    const msgsB = await listConversationMessages(db, ctx(orgB, "admin"), {
      conversationId: convs[0]!.id,
    });
    expect(msgsB).toHaveLength(0);
  });

  it("returns the newest messages when the thread exceeds the limit", async () => {
    const conversationId = await withTenant(db, orgA, async (tx) => {
      await ingestChannelEvent(tx, connA, {
        event: {
          ...inbound,
          externalMessageId: "false_tail@c.us_T1",
          from: { channelUserId: "tail@c.us", displayName: "Tail" },
        },
      });
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.externalId, "tail@c.us"));
      for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) {
        await insertMessage(tx, {
          organizationId: orgA,
          conversationId: conv!.id,
          channelConnectionId: connA.id,
          contactId: null,
          direction: "outbound",
          content: { type: "text", text: `m${i}` },
          externalId: `tail-${i}`,
          status: "sent",
          sentAt: new Date(`2024-06-01T00:00:0${i}Z`),
        });
      }
      return conv!.id;
    });
    const rows = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId,
      limit: 3,
    });
    // The seeded inbound is older than m1 — the window must be the tail,
    // in chronological order, not the first page of the thread.
    expect(rows.map((m) => (m.content as { text: string }).text)).toEqual(["m6", "m7", "m8"]);
  });

  it("getConversationDetail joins contact + names and hides cross-org ids", async () => {
    const convs = await listTenantConversations(db, ctx(orgA, "agent"), { limit: 10 });
    const detail = await getConversationDetail(db, ctx(orgA, "agent"), {
      conversationId: convs[0]!.id,
    });
    expect(detail.id).toBe(convs[0]!.id);
    expect(detail.contactChannelUserId).toBeTruthy();
    expect(detail.ticketNumber).toBeGreaterThan(0);

    await expect(
      getConversationDetail(db, ctx(orgB, "admin"), { conversationId: convs[0]!.id }),
    ).rejects.toThrowError(NotFoundError);
  });
});

describe("conversation_reads — per-user unread cursor", () => {
  it("counts inbound after the cursor and is per-user/per-org", async () => {
    const [other] = await db
      .insert(users)
      .values({
        name: "IT Read Other",
        email: `it-rd-o-${crypto.randomUUID().slice(0, 8)}@crm.local`,
      })
      .returning({ id: users.id });
    const otherId = other!.id;
    const conversationId = await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.externalId, "rd@c.us"));
      await ingestChannelEvent(tx, connA, {
        event: {
          ...inbound,
          externalMessageId: "false_rd@c.us_R2",
        },
      });
      return conv!.id;
    });

    // No cursor yet → both inbound messages unread for userId.
    const before = await listTenantConversations(db, ctx(orgA, "agent"), { limit: 10 });
    expect(before.find((c) => c.id === conversationId)?.unreadCount).toBe(2);

    await markConversationRead(db, ctx(orgA, "agent"), {
      input: { conversationId },
      deps: {
        provider: new FakeChannelProvider(),
      },
    });
    const after = await listTenantConversations(db, ctx(orgA, "agent"), { limit: 10 });
    expect(after.find((c) => c.id === conversationId)?.unreadCount).toBe(0);

    // Another user has their own cursor — still sees both unread.
    const otherCtx: TenantContext = {
      organizationId: orgA,
      userId: otherId,
      role: "agent",
      isPlatformAdmin: false,
    };
    const otherRows = await listTenantConversations(db, otherCtx, { limit: 10 });
    expect(otherRows.find((c) => c.id === conversationId)?.unreadCount).toBe(2);

    // Cross-org: marking org A's conversation from org B is invisible.
    await expect(
      markConversationRead(db, ctx(orgB, "admin"), { input: { conversationId } }),
    ).rejects.toThrowError(NotFoundError);
  });

  it("projects the last message's mediaKind (icon on the row preview)", async () => {
    const conversationId = await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.externalId, "rd@c.us"));
      // Voice note as the latest message → mediaKind surfaces on the row.
      await ingestChannelEvent(tx, connA, {
        event: {
          ...inbound,
          externalMessageId: "false_rd@c.us_R3",
          content: {
            type: "media",
            mediaKind: "audio",
            source: { type: "url", url: "https://cdn.example.com/n.ogg" },
          },
        },
      });
      return conv!.id;
    });

    const rows = await listTenantConversations(db, ctx(orgA, "agent"), {
      view: "all",
      limit: 50,
    });
    const row = rows.find((c) => c.id === conversationId);
    expect(row?.lastMessageMediaKind).toBe("audio");
  });
});

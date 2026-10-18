// Integration test — requires Postgres with migrations applied.
// Message-level actions against the channel provider: pickup sendSeen,
// reactions, edits (window + history), deletes, presence, subscribe.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { pickupConversation } from "./actions";
import { editMessageContent, reactToMessage } from "./message-actions";
import { sendOutboundMessage } from "./outbound";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const {
  channelConnections,
  conversations,
  messageEdits,
  messageReactions,
  messages,
  organizationMembers,
  organizations,
  users,
} = schema;

let db: Database;
let orgA: string;
let userId: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

async function newTicket(channelUserId: string, messageId: string) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Act" },
        content: { type: "text", text: "hi" },
        timestamp: new Date("2024-04-07"),
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.externalId, channelUserId), eq(conversations.status, "open")));
    return conv!;
  });
}

/** Agent sends a text reply (assigns the ticket) and returns the row. */
async function sendReply(conversationId: string, provider: FakeChannelProvider) {
  const message = await sendOutboundMessage(db, ctx(orgA, "agent"), {
    input: { conversationId, text: "reply" },
    deps: { provider },
  });
  return message;
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
    .values({ name: "IT Chat", email: `it-chat-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Chat IT A", slug: `chat-a-${suffix}` })
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
        webhookToken: `tok-chat-${suffix}`,
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

describe("pickupConversation — sendSeen", () => {
  it("marks the chat read only after the agent takes the ticket", async () => {
    const ticket = await newTicket("seen-1@c.us", "false_seen1@c.us_1");
    const provider = new FakeChannelProvider();
    expect(provider.seenChats).toHaveLength(0); // no read/pickup call yet → no seen
    await pickupConversation(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id },
      deps: { provider },
    });
    expect(provider.seenChats).toEqual(["seen-1@c.us"]);
  });

  it("a failing sendSeen does not fail the pickup", async () => {
    const ticket = await newTicket("seen-2@c.us", "false_seen2@c.us_1");
    const provider = new FakeChannelProvider();
    provider.sendSeen = () => Promise.reject(new Error("waha down"));
    const conv = await pickupConversation(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id },
      deps: { provider },
    });
    expect(conv.assigneeId).toBe(userId);
    expect(conv.status).toBe("in_progress");
  });
});

describe("reactToMessage", () => {
  it("sends the reaction, stores it under the user key, removes on ''", async () => {
    const ticket = await newTicket("rx-1@c.us", "false_rx1@c.us_1");
    const provider = new FakeChannelProvider();
    await pickupConversation(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id },
      deps: { provider },
    });
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_rx1@c.us_1")),
    );

    await reactToMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: inbound!.id, emoji: "👍" },
      deps: { provider },
    });
    expect(provider.reactions).toEqual([{ messageExternalId: "false_rx1@c.us_1", emoji: "👍" }]);
    let rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, inbound!.id)),
    );
    expect(rows).toHaveLength(1);
    // reactorKey "me" matches the webhook echo's key — the echo upserts
    // onto this row instead of creating a duplicate.
    expect(rows[0]).toMatchObject({ reactorKey: "me", actorUserId: userId, fromMe: true });

    // Echo of our own reaction (fromMe + same emoji) dedupes to one row.
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.reaction",
          messageExternalId: "false_rx1@c.us_1",
          emoji: "👍",
          actorChannelUserId: null,
          fromMe: true,
        },
      }),
    );
    rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, inbound!.id)),
    );
    expect(rows).toHaveLength(1);

    await reactToMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: inbound!.id, emoji: "" },
      deps: { provider },
    });
    rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, inbound!.id)),
    );
    expect(rows).toHaveLength(0);
  });

  it("rejects reactions to non-channel messages", async () => {
    const ticket = await newTicket("rx-2@c.us", "false_rx2@c.us_1");
    const provider = new FakeChannelProvider();
    const reply = await sendReply(ticket.id, provider); // fake externalId ok
    await withTenant(db, orgA, (tx) =>
      tx.update(messages).set({ externalId: null }).where(eq(messages.id, reply.id)),
    );
    await expect(
      reactToMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, messageId: reply.id, emoji: "👍" },
        deps: { provider },
      }),
    ).rejects.toThrowError(/channel messages accept reactions/);
  });
});

describe("editMessageContent", () => {
  it("edits own outbound message and records the previous content", async () => {
    const ticket = await newTicket("ed-1@c.us", "false_ed1@c.us_1");
    const provider = new FakeChannelProvider();
    const reply = await sendReply(ticket.id, provider);

    await editMessageContent(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: reply.id, text: "reply v2" },
      deps: { provider },
    });
    expect(provider.edits).toHaveLength(1);
    expect(provider.edits[0]).toMatchObject({
      chatId: "ed-1@c.us",
      text: "reply v2",
    });
    const [row, edits] = await withTenant(db, orgA, async (tx) => {
      const m = await tx.select().from(messages).where(eq(messages.id, reply.id));
      const e = await tx.select().from(messageEdits).where(eq(messageEdits.messageId, reply.id));
      return [m[0]!, e];
    });
    expect(row.content).toMatchObject({ text: "reply v2" });
    expect(row.editedAt).not.toBeNull();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      editedByUserId: userId,
      previousContent: { type: "text", text: "reply" },
    });
  });

  it("rejects editing inbound messages and expired windows", async () => {
    const ticket = await newTicket("ed-2@c.us", "false_ed2@c.us_1");
    const provider = new FakeChannelProvider();
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_ed2@c.us_1")),
    );
    await expect(
      editMessageContent(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, messageId: inbound!.id, text: "x" },
        deps: { provider },
      }),
    ).rejects.toThrowError(/own outbound channel messages/);

    const reply = await sendReply(ticket.id, provider);
    await withTenant(db, orgA, (tx) =>
      tx
        .update(messages)
        .set({ sentAt: new Date(Date.now() - 20 * 60_000) })
        .where(eq(messages.id, reply.id)),
    );
    await expect(
      editMessageContent(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, messageId: reply.id, text: "x" },
        deps: { provider },
      }),
    ).rejects.toThrowError(/15min/);
    expect(provider.edits).toHaveLength(0);
  });
});

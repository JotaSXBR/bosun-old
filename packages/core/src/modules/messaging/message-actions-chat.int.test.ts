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
import { deleteMessageContent, sendChatPresence, subscribeChatPresence } from "./message-actions";
import { sendChannelMessage, sendOutboundMessage } from "./outbound";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, conversations, messages, organizationMembers, organizations, users } =
  schema;

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

describe("deleteMessageContent", () => {
  it("revokes own outbound message — content preserved, revoked_at set", async () => {
    const ticket = await newTicket("del-1@c.us", "false_del1@c.us_1");
    const provider = new FakeChannelProvider();
    const reply = await sendReply(ticket.id, provider);

    await deleteMessageContent(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: reply.id },
      deps: { provider },
    });
    expect(provider.deletions).toEqual([
      { chatId: "del-1@c.us", messageExternalId: reply.externalId },
    ]);
    const [row] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.id, reply.id)),
    );
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.content).toMatchObject({ text: "reply" });
  });
});

describe("presence", () => {
  it("sendChatPresence emits to the remote; viewer role rejected", async () => {
    const ticket = await newTicket("pr-1@c.us", "false_pr1@c.us_1");
    const provider = new FakeChannelProvider();
    await sendReply(ticket.id, provider); // assigns

    await sendChatPresence(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, presence: "typing" },
      deps: { provider },
    });
    expect(provider.presences).toEqual([{ chatId: "pr-1@c.us", presence: "typing" }]);

    await expect(
      sendChatPresence(db, ctx(orgA, "viewer"), {
        input: { conversationId: ticket.id, presence: "typing" },
        deps: { provider },
      }),
    ).rejects.toThrowError(/permission|denied/i);
  });

  it("subscribeChatPresence needs only read permission", async () => {
    const ticket = await newTicket("pr-2@c.us", "false_pr2@c.us_1");
    const provider = new FakeChannelProvider();
    await subscribeChatPresence(db, ctx(orgA, "viewer"), {
      input: { conversationId: ticket.id },
      deps: { provider },
    });
    expect(provider.subscribedChats).toEqual(["pr-2@c.us"]);
  });
});

describe("sendChannelMessage — media + reply", () => {
  it("sends media content and replyToId through the provider", async () => {
    const ticket = await newTicket("mm-1@c.us", "false_mm1@c.us_1");
    const provider = new FakeChannelProvider();
    const message = await sendChannelMessage(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
        content: {
          type: "media",
          mediaKind: "audio",
          url: "https://storage.example.com/signed/voice.ogg",
          mimeType: "audio/ogg; codecs=opus",
          voiceNote: true,
        },
        replyToId: "false_mm1@c.us_1",
      },
      deps: { provider },
    });
    expect(provider.sentMessages[0]).toMatchObject({
      to: "mm-1@c.us",
      replyToId: "false_mm1@c.us_1",
      content: {
        type: "media",
        mediaKind: "audio",
        voiceNote: true,
        source: { type: "url", url: "https://storage.example.com/signed/voice.ogg" },
      },
    });
    expect(message.content).toMatchObject({ mediaKind: "audio", voiceNote: true });
  });
});

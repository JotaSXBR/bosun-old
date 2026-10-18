// Integration test — requires Postgres with migrations applied.
// Outbound actions: provider sends, failed-send audit, private notes.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { setUserPreferences } from "../users";
import { pickupConversation, resolveConversation } from "./actions";
import { sendOutboundMessage } from "./outbound";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent, listConversationMessages, markConversationRead } from "./service";

const { channelConnections, conversations, organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let userId: string;
let agent2: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

/** Ingests one inbound on connA/orgA and returns the resulting active ticket. */
async function newTicket(channelUserId: string, messageId: string, timestamp: Date) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Act" },
        content: { type: "text", text: "hi" },
        timestamp,
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.externalId, channelUserId),
          sql`${conversations.status} != 'resolved'`,
        ),
      );
    return conv!;
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
  const inserted = await db
    .insert(users)
    .values([
      { name: "IT Out User", email: `it-out-${suffix}@crm.local` },
      { name: "IT Out Agent2", email: `it-out2-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  userId = inserted[0]!.id;
  agent2 = inserted[1]!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Out IT A", slug: `out-a-${suffix}` })
    .returning({ id: organizations.id });
  orgA = org!.id;
  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId, role: "agent" },
    { organizationId: orgA, userId: agent2, role: "agent" },
  ]);
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-out-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} = ${orgA}`);
  await db.delete(users).where(sql`${users.id} in (${userId}, ${agent2})`);
  await db.$client.end();
});

describe("sendOutboundMessage", () => {
  it("sends via provider, persists the reply, moves to waiting_customer", async () => {
    const ticket = await newTicket("out-1@c.us", "false_out1@c.us_1", new Date("2024-04-01"));
    const provider = new FakeChannelProvider();

    const message = await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "hello back" },
      deps: { provider },
    });

    // Provider saw the domain-level outbound message, addressed to the chat.
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]!.to).toBe("out-1@c.us");
    expect(message.direction).toBe("outbound");
    expect(message.status).toBe("sent");
    expect(message.externalId).toMatch(/^fake-msg-\d+$/);
    expect(message.authorId).toBe(userId);
    expect(message.private).toBe(false);

    await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, ticket.id));
      // Reply claims the ticket and waits on the customer.
      expect(conv!.status).toBe("waiting_customer");
      expect(conv!.assigneeId).toBe(userId);
      expect(conv!.firstResponseAt).not.toBeNull();
    });
  });

  it("stamps first_response_at once; another agent is rejected before the provider call", async () => {
    const ticket = await newTicket("out-2@c.us", "false_out2@c.us_1", new Date("2024-04-02"));
    const provider = new FakeChannelProvider();
    await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "one" },
      deps: { provider },
    });
    const firstResponseAt = await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, ticket.id));
      return conv!.firstResponseAt;
    });
    expect(firstResponseAt).not.toBeNull();

    // Second reply by the same assignee keeps the original stamp.
    await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "two" },
      deps: { provider },
    });
    await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, ticket.id));
      expect(conv!.firstResponseAt).toEqual(firstResponseAt);
    });

    // A different agent can't work the ticket — transfer is the path.
    const hijacker = new FakeChannelProvider();
    await expect(
      sendOutboundMessage(
        db,
        { ...ctx(orgA, "agent"), userId: agent2 },
        { input: { conversationId: ticket.id, text: "hijack" }, deps: { provider: hijacker } },
      ),
    ).rejects.toThrowError(/TICKET_ASSIGNED|transfer/i);
    expect(hijacker.sentMessages).toHaveLength(0);
  });

  it("provider failure keeps a failed message row and throws SEND_FAILED", async () => {
    const ticket = await newTicket("out-3@c.us", "false_out3@c.us_1", new Date("2024-04-03"));
    const provider = new FakeChannelProvider();
    provider.sendMessageError = new Error("session offline");

    await expect(
      sendOutboundMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, text: "will fail" },
        deps: { provider },
      }),
    ).rejects.toThrowError(/SEND_FAILED|failed to send/i);

    const rows = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    const failed = rows.find((m) => m.direction === "outbound");
    expect(failed?.status).toBe("failed");
    // Ticket state untouched by the failed send.
    await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, ticket.id));
      expect(conv!.status).toBe("open");
    });
  });

  it("rejects resolved tickets before touching the provider", async () => {
    const ticket = await newTicket("out-4@c.us", "false_out4@c.us_1", new Date("2024-04-04"));
    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    const provider = new FakeChannelProvider();

    await expect(
      sendOutboundMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, text: "too late" },
        deps: { provider },
      }),
    ).rejects.toThrowError(/immutable|TICKET_RESOLVED/i);
    expect(provider.sentMessages).toHaveLength(0);
  });

  it("read marks seen — sending alone never does", async () => {
    // Customer's inbound is the latest message → the agent's read fires
    // the blue tick; the reply itself is bare (seen = read, not reply).
    const waiting = await newTicket("env-1@c.us", "false_env1@c.us_1", new Date("2024-04-06"));
    const provider = new FakeChannelProvider();
    await markConversationRead(db, ctx(orgA, "agent"), {
      input: { conversationId: waiting.id },
      deps: { provider },
    });
    expect(provider.seenChats).toEqual(["env-1@c.us"]);
    await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: waiting.id, text: "on it" },
      deps: { provider },
    });
    expect(provider.seenChats).toHaveLength(1);
    expect(provider.presences).toHaveLength(0); // humans type via composer events, not here

    // Our outbound is now the latest → re-reading does NOT re-seen.
    await markConversationRead(db, ctx(orgA, "agent"), {
      input: { conversationId: waiting.id },
      deps: { provider },
    });
    expect(provider.seenChats).toHaveLength(1);
  });

  it("read does not mark seen for another agent's ticket", async () => {
    const ticket = await newTicket("own-1@c.us", "false_own1@c.us_1", new Date("2024-04-11"));
    const provider = new FakeChannelProvider();
    await pickupConversation(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id },
      deps: { provider },
    });
    provider.seenChats.length = 0; // clear the pickup tick — testing the read path
    // Ingest a new inbound on the assumed ticket.
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.received",
          externalMessageId: "false_own1@c.us_2",
          from: { channelUserId: "own-1@c.us", displayName: "Act" },
          content: { type: "text", text: "still here?" },
          timestamp: new Date("2024-04-11T00:10:00Z"),
        },
      }),
    );
    // The assignee returning to pending inbound → seen.
    await markConversationRead(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id },
      deps: { provider },
    });
    expect(provider.seenChats).toEqual(["own-1@c.us"]);
    // A different agent (agent2) opening the same ticket → NOT their read signal.
    await markConversationRead(
      db,
      { ...ctx(orgA, "agent"), userId: agent2 },
      { input: { conversationId: ticket.id }, deps: { provider } },
    );
    expect(provider.seenChats).toHaveLength(1);
  });

  it("sendSeen preference off → no blue tick on pickup or read", async () => {
    const ticket = await newTicket("pref-1@c.us", "false_pref1@c.us_1", new Date("2024-04-10"));
    const provider = new FakeChannelProvider();
    await setUserPreferences(db, userId, { sendSeen: false });
    try {
      await pickupConversation(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id },
        deps: { provider },
      });
      await markConversationRead(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id },
        deps: { provider },
      });
      await sendOutboundMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, text: "sem tick azul" },
        deps: { provider },
      });
      expect(provider.seenChats).toHaveLength(0);
      expect(provider.sentMessages).toHaveLength(1);
    } finally {
      await setUserPreferences(db, userId, { sendSeen: true });
    }
  });

  it("automated send runs the anti-ban envelope (seen → typing → paused)", async () => {
    const ticket = await newTicket("env-2@c.us", "false_env2@c.us_1", new Date("2024-04-07"));
    const provider = new FakeChannelProvider();
    await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "resposta automática" },
      deps: { provider, automated: true },
    });
    expect(provider.seenChats).toEqual(["env-2@c.us"]);
    expect(provider.presences).toEqual([
      { chatId: "env-2@c.us", presence: "typing" },
      { chatId: "env-2@c.us", presence: "paused" },
    ]);
    expect(provider.sentMessages).toHaveLength(1);
  }, 15_000);
});

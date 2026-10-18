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
import { resolveConversation } from "./actions";
import { addInternalNote, resendFailedMessage, sendOutboundMessage } from "./outbound";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent, listConversationMessages } from "./service";

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

describe("resendFailedMessage", () => {
  it("resends a failed text message in place and claims the ticket", async () => {
    const ticket = await newTicket("res-1@c.us", "false_res1@c.us_1", new Date("2024-04-08"));
    const failing = new FakeChannelProvider();
    failing.sendMessageError = new Error("session offline");
    await expect(
      sendOutboundMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, text: "tenta de novo" },
        deps: { provider: failing },
      }),
    ).rejects.toThrowError(/failed to send/i);
    const rows = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    const failed = rows.find((m) => m.status === "failed")!;

    const provider = new FakeChannelProvider();
    const resent = await resendFailedMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: failed.id },
      deps: { provider },
    });

    expect(resent.id).toBe(failed.id); // same bubble — no duplicate
    expect(resent.status).toBe("sent");
    expect(resent.externalId).toMatch(/^fake-msg-\d+$/);
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]!.content).toMatchObject({
      type: "text",
      text: "tenta de novo",
    });
    // Resend is a reply, not a read — the read path owns the blue tick.
    expect(provider.seenChats).toHaveLength(0);
    const listed = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    expect(listed.filter((m) => m.status === "failed")).toHaveLength(0);
    await withTenant(db, orgA, async (tx) => {
      const [conv] = await tx.select().from(conversations).where(eq(conversations.id, ticket.id));
      expect(conv!.status).toBe("waiting_customer");
      expect(conv!.assigneeId).toBe(userId);
    });
  });

  it("rejects messages that are not failed outbound", async () => {
    const ticket = await newTicket("res-2@c.us", "false_res2@c.us_1", new Date("2024-04-09"));
    const provider = new FakeChannelProvider();
    const sent = await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "ok" },
      deps: { provider },
    });

    await expect(
      resendFailedMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, messageId: sent.id },
        deps: { provider },
      }),
    ).rejects.toThrowError(/failed outbound/i);
    // Inbound message id → same rejection (and not a resend of the customer's text).
    const rows = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    const inbound = rows.find((m) => m.direction === "inbound")!;
    await expect(
      resendFailedMessage(db, ctx(orgA, "agent"), {
        input: { conversationId: ticket.id, messageId: inbound.id },
        deps: { provider },
      }),
    ).rejects.toThrowError(/failed outbound/i);
    expect(provider.sentMessages).toHaveLength(1);
  });
});

describe("addInternalNote", () => {
  it("note is private, authored, never sent; resolved rejects it", async () => {
    const ticket = await newTicket("note-1@c.us", "false_n1@c.us_1", new Date("2024-04-05"));
    const provider = new FakeChannelProvider();

    const note = await addInternalNote(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
      text: "cliente pediu retorno amanhã",
    });
    expect(note.private).toBe(true);
    expect(note.authorId).toBe(userId);
    expect(note.direction).toBe("outbound");
    expect(provider.sentMessages).toHaveLength(0);
    const listed = await listConversationMessages(db, ctx(orgA, "agent"), {
      conversationId: ticket.id,
    });
    expect(listed.find((m) => m.id === note.id)?.authorName).toBe("IT Out User");
    expect(
      listed.filter((m) => m.direction === "inbound").every((m) => m.authorName === null),
    ).toBe(true);

    await resolveConversation(db, ctx(orgA, "agent"), { input: { conversationId: ticket.id } });
    await expect(
      addInternalNote(db, ctx(orgA, "agent"), { conversationId: ticket.id, text: "late" }),
    ).rejects.toThrowError(/immutable|TICKET_RESOLVED/i);
  });
});

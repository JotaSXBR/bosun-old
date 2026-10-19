// Integration test — requires Postgres with migrations applied.
// Outbound-first: agent opens a ticket to a contact on a WAHA connection.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { resolveConversation } from "./actions";
import { sendOutboundMessage } from "./outbound";
import { startOutboundConversation } from "./outbound-first";
import { ingestChannelEvent } from "./service";

const { channelConnections, contacts, conversations, organizationMembers, organizations, users } =
  schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let memberB: string;
let wahaConn: { id: string };
let pendingConn: { id: string };
let metaConn: { id: string };
let waContact: { id: string; channelUserId: string };
let emailContact: { id: string };

function ctx(organizationId: string, user: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId: user, role, isPlatformAdmin: false };
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
  const insertedUsers = await db
    .insert(users)
    .values([
      { name: "OBF Agent", email: `it-obf-a-${suffix}@crm.local` },
      { name: "OBF B", email: `it-obf-b-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  userId = insertedUsers[0]!.id;
  memberB = insertedUsers[1]!.id;

  const orgs = await db
    .insert(organizations)
    .values([
      { name: "OBF A", slug: `obf-a-${suffix}` },
      { name: "OBF B", slug: `obf-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;

  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId, role: "agent" },
    { organizationId: orgB, userId: memberB, role: "agent" },
  ]);

  const conns = await withTenant(db, orgA, (tx) =>
    tx
      .insert(channelConnections)
      .values([
        {
          organizationId: orgA,
          kind: "waha",
          name: "WAHA ok",
          status: "connected",
          credentialsEncrypted: "x",
          webhookToken: `tok-obf-waha-${suffix}`,
        },
        {
          organizationId: orgA,
          kind: "waha",
          name: "WAHA pending",
          status: "pending",
          credentialsEncrypted: "x",
          webhookToken: `tok-obf-pend-${suffix}`,
        },
        {
          organizationId: orgA,
          kind: "meta_cloud",
          name: "Meta",
          status: "connected",
          credentialsEncrypted: "x",
          webhookToken: `tok-obf-meta-${suffix}`,
        },
      ])
      .returning({ id: channelConnections.id }),
  );
  [wahaConn, pendingConn, metaConn] = conns as [{ id: string }, { id: string }, { id: string }];

  const contactRows = await withTenant(db, orgA, (tx) =>
    tx
      .insert(contacts)
      .values([
        { organizationId: orgA, channelUserId: "5511911112222@c.us", displayName: "WA Contact" },
        { organizationId: orgA, channelUserId: "visitor@example.com", displayName: "Site visitor" },
      ])
      .returning(),
  );
  waContact = { id: contactRows[0]!.id, channelUserId: contactRows[0]!.channelUserId };
  emailContact = { id: contactRows[1]!.id };
}, 60_000);

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} in (${userId}, ${memberB})`);
  await db.$client.end();
});

describe("startOutboundConversation", () => {
  it("creates an in_progress ticket assigned to the caller", async () => {
    const { conversation, created } = await startOutboundConversation(
      db,
      ctx(orgA, userId, "agent"),
      { channelConnectionId: wahaConn.id, contactId: waContact.id },
    );
    expect(created).toBe(true);
    expect(conversation.status).toBe("in_progress");
    expect(conversation.assigneeId).toBe(userId);
    expect(conversation.externalId).toBe("5511911112222@c.us");
    expect(conversation.contactId).toBe(waContact.id);
    expect(conversation.ticketNumber).toBeGreaterThan(0);
    expect(conversation.ticketSeq).toBe(1);
  });

  it("lets the caller send the first message through the normal outbound flow", async () => {
    const provider = new FakeChannelProvider();
    const { conversation } = await startOutboundConversation(db, ctx(orgA, userId, "agent"), {
      channelConnectionId: wahaConn.id,
      contactId: waContact.id,
    });
    // Composer path: sendOutboundMessage on an in_progress ticket owned by
    // the caller → provider send + persisted message + waiting_customer.
    const message = await sendOutboundMessage(db, ctx(orgA, userId, "agent"), {
      input: { conversationId: conversation.id, text: "Olá, posso ajudar?" },
      deps: { provider },
    });
    expect(message.direction).toBe("outbound");
    expect(message.authorId).toBe(userId);
    expect(provider.sentMessages).toHaveLength(1);
    const after = await withTenant(db, orgA, async (tx) => {
      const [row] = await tx
        .select({ status: conversations.status })
        .from(conversations)
        .where(eq(conversations.id, conversation.id));
      return row!;
    });
    expect(after.status).toBe("waiting_customer");
  });

  it("returns the existing active ticket instead of duplicating", async () => {
    const again = await startOutboundConversation(db, ctx(orgA, userId, "agent"), {
      channelConnectionId: wahaConn.id,
      contactId: waContact.id,
    });
    expect(again.created).toBe(false);
    const rows = await withTenant(db, orgA, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channelConnectionId, wahaConn.id),
            eq(conversations.externalId, "5511911112222@c.us"),
          ),
        ),
    );
    expect(rows).toHaveLength(1);
  });

  it("links preceded_by to the last terminal ticket on reopen-outbound", async () => {
    // Resolve the ticket from the previous tests, then open a new outbound —
    // it must chain to the resolved one.
    const first = await withTenant(db, orgA, async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channelConnectionId, wahaConn.id),
            eq(conversations.externalId, "5511911112222@c.us"),
          ),
        );
      return row!;
    });
    await resolveConversation(db, ctx(orgA, userId, "agent"), {
      input: { conversationId: first.id },
    });

    const { conversation, created } = await startOutboundConversation(
      db,
      ctx(orgA, userId, "agent"),
      { channelConnectionId: wahaConn.id, contactId: waContact.id },
    );
    expect(created).toBe(true);
    expect(conversation.precededById).toBe(first.id);
    expect(conversation.ticketSeq).toBe(2);
  });

  it("rejects non-waha and non-connected connections", async () => {
    await expect(
      startOutboundConversation(db, ctx(orgA, userId, "agent"), {
        channelConnectionId: metaConn.id,
        contactId: waContact.id,
      }),
    ).rejects.toMatchObject({ code: "OUTBOUND_CHANNEL_UNSUPPORTED" });
    await expect(
      startOutboundConversation(db, ctx(orgA, userId, "agent"), {
        channelConnectionId: pendingConn.id,
        contactId: waContact.id,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_CONNECTED" });
  });

  it("rejects contacts without a WhatsApp identity", async () => {
    await expect(
      startOutboundConversation(db, ctx(orgA, userId, "agent"), {
        channelConnectionId: wahaConn.id,
        contactId: emailContact.id,
      }),
    ).rejects.toMatchObject({ code: "CONTACT_NOT_REACHABLE" });
  });

  it("denies viewer and cross-org access", async () => {
    await expect(
      startOutboundConversation(db, ctx(orgA, userId, "viewer"), {
        channelConnectionId: wahaConn.id,
        contactId: waContact.id,
      }),
    ).rejects.toThrowError(AuthorizationError);
    // Org B sees neither the connection nor the contact (RLS) → NOT_FOUND.
    await expect(
      startOutboundConversation(db, ctx(orgB, memberB, "agent"), {
        channelConnectionId: wahaConn.id,
        contactId: waContact.id,
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it("ingest on the same chat still resolves the same contact/ticket chain", async () => {
    // Inbound from the same chatId lands on the still-active outbound
    // ticket — same contact row, one active conversation.
    const connRef = { id: wahaConn.id, organizationId: orgA, kind: "waha" };
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connRef, {
        event: {
          type: "message.received",
          externalMessageId: "false_5511911112222@c.us_OBF1",
          from: { channelUserId: "5511911112222@c.us", displayName: "WA Contact" },
          content: { type: "text", text: "oi, recebi" },
          timestamp: new Date(),
        },
      }),
    );
    const rows = await withTenant(db, orgA, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.channelConnectionId, wahaConn.id),
            eq(conversations.externalId, "5511911112222@c.us"),
          ),
        ),
    );
    // previous resolved + the active outbound ticket (inbound landed on it)
    expect(rows.filter((r) => r.status !== "resolved" && r.status !== "closed")).toHaveLength(1);
    const contactCount = await withTenant(db, orgA, (tx) =>
      tx.select().from(contacts).where(eq(contacts.channelUserId, "5511911112222@c.us")),
    );
    expect(contactCount).toHaveLength(1);
  });
});

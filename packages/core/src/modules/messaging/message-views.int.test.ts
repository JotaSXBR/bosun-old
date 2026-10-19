// Integration test — requires Postgres with migrations applied.
// Privileged reads (revoked original, edit history) and the media resolver
// behind the authenticated /api/media proxy route.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { deleteMessageContent, editMessageContent } from "./message-actions";
import { getMessageContent, getMessageEdits } from "./message-views";
import { sendOutboundMessage } from "./outbound";
import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, conversations, organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let userId: string;
let connA: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

async function newTicket(channelUserId: string, messageId: string, media = false) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: messageId,
        from: { channelUserId, displayName: "Views" },
        content: media
          ? {
              type: "media",
              mediaKind: "audio",
              source: { type: "url", url: `https://waha.internal/media/${messageId}` },
              mimeType: "audio/ogg; codecs=opus",
            }
          : { type: "text", text: "hi" },
        timestamp: new Date("2024-04-08"),
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
    .values({ name: "IT Views", email: `it-views-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  const [org] = await db
    .insert(organizations)
    .values({ name: "Views IT A", slug: `views-a-${suffix}` })
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
        webhookToken: `tok-views-${suffix}`,
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

describe("privileged reads — original + edit history", () => {
  it("agents are denied; managers can read the revoked original", async () => {
    const ticket = await newTicket("pv-1@c.us", "false_pv1@c.us_1");
    const provider = new FakeChannelProvider();
    const reply = await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "secret outbound" },
      deps: { provider },
    });
    await deleteMessageContent(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: reply.id },
      deps: { provider },
    });

    const input = { conversationId: ticket.id, messageId: reply.id };
    await expect(getMessageContent(db, ctx(orgA, "agent"), input)).rejects.toThrowError(
      /owner\/admin\/manager/,
    );
    const original = await getMessageContent(db, ctx(orgA, "manager"), input);
    expect(original.revokedAt).not.toBeNull();
    expect(original.content).toMatchObject({ text: "secret outbound" });
  });

  it("edit history is privileged too and lists previous versions", async () => {
    const ticket = await newTicket("pv-2@c.us", "false_pv2@c.us_1");
    const provider = new FakeChannelProvider();
    const reply = await sendOutboundMessage(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, text: "v1" },
      deps: { provider },
    });
    await editMessageContent(db, ctx(orgA, "agent"), {
      input: { conversationId: ticket.id, messageId: reply.id, text: "v2" },
      deps: { provider },
    });

    const input = { conversationId: ticket.id, messageId: reply.id };
    await expect(getMessageEdits(db, ctx(orgA, "viewer"), input)).rejects.toThrowError(
      /owner\/admin\/manager/,
    );
    const edits = await getMessageEdits(db, ctx(orgA, "admin"), input);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.previousContent).toMatchObject({ text: "v1" });
  });
});

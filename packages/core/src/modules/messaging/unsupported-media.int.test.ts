// Integration test — requires Postgres with migrations applied.
// maybeSendUnsupportedMediaReply: once-per-ticket system reply when an
// inbound media lands without a fetchable source (unsupportedMedia flag).
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { FakeChannelProvider } from "@crm/channels/testing";
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";
import { maybeSendUnsupportedMediaReply } from "./unsupported-media";

const {
  channelConnections,
  conversations,
  messages,
  organizationMembers,
  organizations,
  organizationSettings,
  users,
} = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;
let connB: ConnectionRef;

const TEMPLATE = "Não conseguimos abrir esse arquivo — pode reenviar em outro formato?";

async function configureOrg(org: string) {
  await withTenant(db, org, (tx) =>
    tx.insert(organizationSettings).values({
      organizationId: org,
      unsupportedMediaMessage: TEMPLATE,
    }),
  );
}

/** Ingests an inbound media message; empty url raises the unsupported flag. */
async function inboundMedia(
  org: string,
  conn: ConnectionRef,
  { channelUserId, msgId, url }: { channelUserId: string; msgId: string; url: string },
) {
  const result = await withTenant(db, org, (tx) =>
    ingestChannelEvent(tx, conn, {
      event: {
        type: "message.received",
        externalMessageId: msgId,
        from: { channelUserId, displayName: "Cust" },
        content: {
          type: "media",
          mediaKind: "image",
          mimeType: "image/webp",
          source: { type: "url", url },
        },
        timestamp: new Date("2024-04-07"),
      },
    }),
  );
  const [conv] = await withTenant(db, org, (tx) =>
    tx.select().from(conversations).where(eq(conversations.externalId, channelUserId)).limit(1),
  );
  return { conv: conv!, messageId: result.messageId! };
}

async function markerRows(org: string, conversationId: string) {
  return withTenant(db, org, (tx) =>
    tx
      .select()
      .from(messages)
      .where(
        sql`${messages.conversationId} = ${conversationId}
            and ${messages.metadata} ->> 'system' = 'unsupported_media'`,
      ),
  );
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
    .values({ name: "IT UnsupportedMedia", email: `it-um-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  for (const slug of ["um-a", "um-b"]) {
    const [org] = await db
      .insert(organizations)
      .values({ name: `UM ${slug}`, slug: `${slug}-${suffix}` })
      .returning({ id: organizations.id });
    await db.insert(organizationMembers).values({ organizationId: org!.id, userId, role: "agent" });
    const conn = await withTenant(db, org!.id, async (tx) => {
      const [row] = await tx
        .insert(channelConnections)
        .values({
          organizationId: org!.id,
          kind: "waha",
          name: `IT WAHA ${slug}`,
          credentialsEncrypted: "not-used-in-these-tests",
          webhookToken: `tok-um-${slug}-${suffix}`,
        })
        .returning();
      return { id: row!.id, organizationId: org!.id, kind: row!.kind };
    });
    if (slug === "um-a") {
      orgA = org!.id;
      connA = conn;
    } else {
      orgB = org!.id;
      connB = conn;
    }
  }
  await configureOrg(orgA);
});

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("maybeSendUnsupportedMediaReply", () => {
  it("sends the org template once per ticket and dedups further flags", async () => {
    const { conv, messageId } = await inboundMedia(orgA, connA, {
      channelUserId: "um-1@c.us",
      msgId: "false_um1@c.us_1",
      url: "",
    });
    const provider = new FakeChannelProvider();

    const first = await maybeSendUnsupportedMediaReply(
      db,
      { organizationId: orgA, conversationId: conv.id, messageId },
      { provider },
    );
    expect(first.sent).toBe(true);
    expect(provider.sentMessages).toHaveLength(1);
    expect(provider.sentMessages[0]!.to).toBe("um-1@c.us");
    expect(provider.sentMessages[0]!.content).toEqual({ type: "text", text: TEMPLATE });

    // A second unsupported media on the SAME ticket must not re-send.
    const againMsg = await inboundMedia(orgA, connA, {
      channelUserId: "um-1@c.us",
      msgId: "false_um1@c.us_2",
      url: "",
    });
    const again = await maybeSendUnsupportedMediaReply(
      db,
      { organizationId: orgA, conversationId: conv.id, messageId: againMsg.messageId },
      { provider },
    );
    expect(again).toEqual({ sent: false, reason: "already-sent" });
    expect(provider.sentMessages).toHaveLength(1);

    const markers = await markerRows(orgA, conv.id);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.authorId).toBeNull();
    expect(markers[0]!.direction).toBe("outbound");
    expect(markers[0]!.status).toBe("sent");
    // The ticket is NOT mutated like an agent reply — stays open/unassigned.
    const [row] = await withTenant(db, orgA, (tx) =>
      tx.select().from(conversations).where(eq(conversations.id, conv.id)),
    );
    expect(row!.status).toBe("open");
    expect(row!.assigneeId).toBeNull();
  });

  it("stays silent when the message has a fetchable source or no template", async () => {
    // Supported media (url set) → no flag → no reply even when configured.
    const supported = await inboundMedia(orgA, connA, {
      channelUserId: "um-2@c.us",
      msgId: "false_um2@c.us_1",
      url: "https://waha.local/api/files/x.webp",
    });
    const provider = new FakeChannelProvider();
    const noFlag = await maybeSendUnsupportedMediaReply(
      db,
      { organizationId: orgA, conversationId: supported.conv.id, messageId: supported.messageId },
      { provider },
    );
    expect(noFlag).toEqual({ sent: false, reason: "not-unsupported" });
    expect(provider.sentMessages).toHaveLength(0);

    // Org B never set the template → hard no.
    const flaggedB = await inboundMedia(orgB, connB, {
      channelUserId: "um-3@c.us",
      msgId: "false_um3@c.us_1",
      url: "",
    });
    const noCfg = await maybeSendUnsupportedMediaReply(
      db,
      { organizationId: orgB, conversationId: flaggedB.conv.id, messageId: flaggedB.messageId },
      { provider },
    );
    expect(noCfg).toEqual({ sent: false, reason: "not-configured" });
    expect(provider.sentMessages).toHaveLength(0);
    expect(await markerRows(orgB, flaggedB.conv.id)).toHaveLength(0);
  });

  it("provider failure marks the marker failed and a retry sends again", async () => {
    const { conv, messageId } = await inboundMedia(orgA, connA, {
      channelUserId: "um-4@c.us",
      msgId: "false_um4@c.us_1",
      url: "",
    });
    const failing = new FakeChannelProvider();
    failing.sendMessageError = new Error("provider down");

    await expect(
      maybeSendUnsupportedMediaReply(
        db,
        { organizationId: orgA, conversationId: conv.id, messageId },
        { provider: failing },
      ),
    ).rejects.toThrow("provider down");
    const failed = await markerRows(orgA, conv.id);
    expect(failed[0]!.status).toBe("failed");

    // Template edited while the marker was failed — the retry sends the
    // CURRENT text and the row mirrors what actually went out.
    const updated = "Template novo — reenvie em outro formato.";
    await withTenant(db, orgA, (tx) =>
      tx
        .update(organizationSettings)
        .set({ unsupportedMediaMessage: updated })
        .where(eq(organizationSettings.organizationId, orgA)),
    );
    const ok = new FakeChannelProvider();
    const retry = await maybeSendUnsupportedMediaReply(
      db,
      { organizationId: orgA, conversationId: conv.id, messageId },
      { provider: ok },
    );
    expect(retry.sent).toBe(true);
    expect(retry.sent && retry.messageId).toBe(failed[0]!.id);
    const after = await markerRows(orgA, conv.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("sent");
    expect(after[0]!.content).toEqual({ type: "text", text: updated });
  });
});

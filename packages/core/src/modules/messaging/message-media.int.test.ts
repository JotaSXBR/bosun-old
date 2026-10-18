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
import { resolveMessageMedia } from "./message-views";
import { sendChannelMessage } from "./outbound";
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

describe("resolveMessageMedia — media proxy source", () => {
  it("serves outbound uploads from object storage", async () => {
    const ticket = await newTicket("md-1@c.us", "false_md1@c.us_1");
    const provider = new FakeChannelProvider();
    const sent = await sendChannelMessage(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
        content: {
          type: "media",
          mediaKind: "document",
          url: "https://storage.example.com/signed/doc.pdf",
          mimeType: "application/pdf",
          filename: "doc.pdf",
          storageKey: `org/${orgA}/outbound/doc-1`,
        },
      },
      deps: { provider },
    });

    const bytes = new Uint8Array([1, 2, 3]);
    const downloads: string[] = [];
    const resolved = await resolveMessageMedia(db, ctx(orgA, "agent"), {
      input: { messageId: sent.id },
      deps: {
        downloadObject: (key) => {
          downloads.push(key);
          return Promise.resolve({ body: bytes, contentType: "application/pdf" });
        },
        fetchProviderMedia: () => Promise.reject(new Error("must not be called")),
      },
    });
    expect(downloads).toEqual([`org/${orgA}/outbound/doc-1`]);
    expect(resolved).toMatchObject({
      body: bytes,
      contentType: "application/pdf",
      filename: "doc.pdf",
    });
  });

  it("serves inbound media through the provider fetch", async () => {
    await newTicket("md-2@c.us", "false_md2@c.us_1", true);
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_md2@c.us_1")),
    );
    const seen: string[] = [];
    const resolved = await resolveMessageMedia(db, ctx(orgA, "agent"), {
      input: { messageId: inbound!.id },
      deps: {
        fetchProviderMedia: (connectionId, url) => {
          seen.push(`${connectionId}:${url}`);
          return Promise.resolve({ body: new Uint8Array([9]), contentType: "audio/ogg" });
        },
      },
    });
    expect(seen).toEqual([`${connA.id}:https://waha.internal/media/false_md2@c.us_1`]);
    expect(resolved).toMatchObject({ contentType: "audio/ogg" });
    expect(resolved!.body).toEqual(new Uint8Array([9]));
  });

  it("falls back to the by-id download when the stored url fails", async () => {
    // Sticker-style inbound: the stored url is the WhatsApp CDN (.enc) —
    // the provider refuses to fetch it, so the resolver retries by
    // (chatId, messageId): conversation.externalId + message.externalId.
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.received",
          externalMessageId: "false_md5@c.us_1",
          from: { channelUserId: "md-5@c.us", displayName: "Views" },
          content: {
            type: "media",
            mediaKind: "image",
            source: { type: "url", url: "https://mmg.whatsapp.net/v/x.enc" },
            mimeType: "image/webp",
          },
          timestamp: new Date("2024-04-08"),
        },
      }),
    );
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_md5@c.us_1")),
    );
    const calls: string[] = [];
    const resolved = await resolveMessageMedia(db, ctx(orgA, "agent"), {
      input: { messageId: inbound!.id },
      deps: {
        fetchProviderMedia: () => Promise.reject(new Error("refused: url outside the WAHA host")),
        fetchMessageMedia: (connectionId, chatId, messageExternalId) => {
          calls.push(`${connectionId}:${chatId}:${messageExternalId}`);
          return Promise.resolve({ body: new Uint8Array([7]), contentType: "image/webp" });
        },
      },
    });
    expect(calls).toEqual([`${connA.id}:md-5@c.us:false_md5@c.us_1`]);
    expect(resolved).toMatchObject({ contentType: "image/webp" });
    expect(resolved!.body).toEqual(new Uint8Array([7]));
  });

  it("revoked media is restricted to inspector roles", async () => {
    await newTicket("md-r@c.us", "false_mdr@c.us_1", true);
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_mdr@c.us_1")),
    );
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.revoked",
          messageExternalId: "false_mdr@c.us_1",
        },
      }),
    );
    const deps = {
      fetchProviderMedia: () =>
        Promise.resolve({ body: new Uint8Array([1]), contentType: "audio/ogg" }),
    };
    // Regular roles are refused — same gate as the "ver original" text.
    await expect(
      resolveMessageMedia(db, ctx(orgA, "agent"), { input: { messageId: inbound!.id }, deps }),
    ).rejects.toThrowError(/restricted|owner\/admin\/manager/i);
    // Inspectors still get the bytes.
    const resolved = await resolveMessageMedia(db, ctx(orgA, "admin"), {
      input: { messageId: inbound!.id },
      deps,
    });
    expect(resolved).toMatchObject({ contentType: "audio/ogg" });
  });

  it("rejects a storageKey outside the caller's tenant prefix", async () => {
    const ticket = await newTicket("md-x@c.us", "false_mdx@c.us_1");
    const provider = new FakeChannelProvider();
    const sent = await sendChannelMessage(db, ctx(orgA, "agent"), {
      input: {
        conversationId: ticket.id,
        content: {
          type: "media",
          mediaKind: "document",
          url: "https://storage.example.com/signed/x.pdf",
          mimeType: "application/pdf",
          storageKey: `org/${crypto.randomUUID()}/outbound/victim.pdf`,
        },
      },
      deps: { provider },
    });
    const resolved = await resolveMessageMedia(db, ctx(orgA, "agent"), {
      input: { messageId: sent.id },
      deps: {
        downloadObject: () => Promise.reject(new Error("must not download cross-tenant keys")),
      },
    });
    expect(resolved).toBeNull();
  });

  it("rejects non-media messages and unknown ids", async () => {
    await newTicket("md-3@c.us", "false_md3@c.us_1");
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_md3@c.us_1")),
    );
    await expect(
      resolveMessageMedia(db, ctx(orgA, "agent"), { input: { messageId: inbound!.id }, deps: {} }),
    ).rejects.toThrowError(/no media content/);
    await expect(
      resolveMessageMedia(db, ctx(orgA, "agent"), {
        input: { messageId: crypto.randomUUID() },
        deps: {},
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it("returns null when the media has no reachable source", async () => {
    await newTicket("md-4@c.us", "false_md4@c.us_1", true);
    const [inbound] = await withTenant(db, orgA, (tx) =>
      tx.select().from(messages).where(eq(messages.externalId, "false_md4@c.us_1")),
    );
    // url-sourced media but no fetchProviderMedia dep → null
    const resolved = await resolveMessageMedia(db, ctx(orgA, "agent"), {
      input: { messageId: inbound!.id },
      deps: {},
    });
    expect(resolved).toBeNull();
  });
});

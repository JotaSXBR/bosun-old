// Integration test — requires Postgres with migrations applied.
// Ingest of the chat-mutation events: message.reaction (upsert/replace/
// remove), message.edited (history + dedup of our own echo),
// message.revoked (revoked_at keeps content), contact.presence
// (notify-only, no row writes).
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ConnectionRef } from "./service";
import { ingestChannelEvent } from "./service";

const { channelConnections, messageEdits, messageReactions, messages } = schema;

let db: Database;
let orgA: string;
let connA: ConnectionRef;

async function newMessage(channelUserId: string, externalId: string, text: string) {
  await withTenant(db, orgA, (tx) =>
    ingestChannelEvent(tx, connA, {
      event: {
        type: "message.received",
        externalMessageId: externalId,
        from: { channelUserId, displayName: "Evt" },
        content: { type: "text", text },
        timestamp: new Date("2024-04-07"),
      },
    }),
  );
  return withTenant(db, orgA, async (tx) => {
    const [row] = await tx.select().from(messages).where(eq(messages.externalId, externalId));
    return row!;
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
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Evt IT", slug: `evt-${suffix}` })
    .returning({ id: schema.organizations.id });
  orgA = org!.id;
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA",
        credentialsEncrypted: "not-used-in-these-tests",
        webhookToken: `tok-evt-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
});

afterAll(async () => {
  await db.delete(schema.organizations).where(sql`${schema.organizations.id} = ${orgA}`);
  await db.$client.end();
});

describe("message.reaction ingest", () => {
  it("upserts, replaces and removes a contact reaction", async () => {
    const msg = await newMessage("r1@c.us", "false_r1@c.us_1", "oi");

    const react = (emoji: string) =>
      withTenant(db, orgA, (tx) =>
        ingestChannelEvent(tx, connA, {
          event: {
            type: "message.reaction",
            messageExternalId: "false_r1@c.us_1",
            emoji,
            actorChannelUserId: "r1@c.us",
            fromMe: false,
          },
        }),
      );

    await react("👍");
    let rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, msg.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ emoji: "👍", reactorKey: "r1@c.us", fromMe: false });

    // Same actor, new emoji → replaces (one reaction per actor).
    await react("❤️");
    rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, msg.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.emoji).toBe("❤️");

    // Empty emoji removes.
    await react("");
    rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, msg.id)),
    );
    expect(rows).toHaveLength(0);
  });

  it("keeps 'me' reactions on a separate reactor slot", async () => {
    const msg = await newMessage("r2@c.us", "false_r2@c.us_1", "oi");
    for (const [key, fromMe, actor] of [
      ["me", true, null],
      ["r2@c.us", false, "r2@c.us"],
    ] as const) {
      await withTenant(db, orgA, (tx) =>
        ingestChannelEvent(tx, connA, {
          event: {
            type: "message.reaction",
            messageExternalId: "false_r2@c.us_1",
            emoji: "👍",
            actorChannelUserId: actor,
            fromMe,
          },
        }),
      );
      void key;
    }
    const rows = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageReactions).where(eq(messageReactions.messageId, msg.id)),
    );
    expect(rows.map((r) => r.reactorKey).sort()).toEqual(["me", "r2@c.us"]);
  });

  it("ignores reactions to unknown messages", async () => {
    const result = await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.reaction",
          messageExternalId: "false_nope@c.us_x",
          emoji: "👍",
          actorChannelUserId: "nope@c.us",
          fromMe: false,
        },
      }),
    );
    expect(result).toEqual({ eventType: "message.reaction", messageId: null });
  });
});

describe("message.edited ingest", () => {
  it("updates content, records history and stamps edited_at", async () => {
    const msg = await newMessage("e1@c.us", "false_e1@c.us_1", "original");
    const result = await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.edited",
          messageExternalIds: ["true_e1@c.us_1", "false_e1@c.us_1"],
          newText: "edited text",
        },
      }),
    );
    expect(result.messageId).toBe(msg.id);

    const updated = await withTenant(db, orgA, async (tx) => {
      const [row] = await tx.select().from(messages).where(eq(messages.id, msg.id));
      return row!;
    });
    expect(updated.content).toEqual({ type: "text", text: "edited text" });
    expect(updated.editedAt).not.toBeNull();

    const edits = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageEdits).where(eq(messageEdits.messageId, msg.id)),
    );
    expect(edits).toHaveLength(1);
    expect(edits[0]?.previousContent).toEqual({ type: "text", text: "original" });
  });

  it("edits a media caption in place — mediaKind/source are preserved", async () => {
    const mediaId = "false_me1@c.us_1";
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.received",
          externalMessageId: mediaId,
          from: { channelUserId: "me1@c.us", displayName: "Evt" },
          content: {
            type: "media",
            mediaKind: "image",
            source: { type: "url", url: "https://waha.internal/media/pic.jpg" },
            mimeType: "image/jpeg",
            caption: "old caption",
          },
          timestamp: new Date("2024-04-07"),
        },
      }),
    );
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.edited",
          messageExternalIds: [mediaId],
          newText: "new caption",
        },
      }),
    );
    const row = await withTenant(db, orgA, async (tx) => {
      const [m] = await tx.select().from(messages).where(eq(messages.externalId, mediaId));
      return m!;
    });
    expect(row.content).toMatchObject({
      type: "media",
      mediaKind: "image",
      caption: "new caption",
      source: { type: "url", url: "https://waha.internal/media/pic.jpg" },
    });
  });

  it("dedupes the echo of our own edit (identical content → no history row)", async () => {
    const msg = await newMessage("e2@c.us", "false_e2@c.us_1", "same");
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.edited",
          messageExternalIds: ["false_e2@c.us_1"],
          newText: "same",
        },
      }),
    );
    const edits = await withTenant(db, orgA, (tx) =>
      tx.select().from(messageEdits).where(eq(messageEdits.messageId, msg.id)),
    );
    expect(edits).toHaveLength(0);
    const row = await withTenant(db, orgA, async (tx) => {
      const [m] = await tx.select().from(messages).where(eq(messages.id, msg.id));
      return m!;
    });
    expect(row.editedAt).toBeNull();
  });
});

describe("message.revoked ingest", () => {
  it("stamps revoked_at while preserving the original content", async () => {
    const msg = await newMessage("v1@c.us", "false_v1@c.us_1", "sigilo");
    const result = await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.revoked",
          messageExternalId: "false_v1@c.us_1",
        },
      }),
    );
    expect(result.messageId).toBe(msg.id);
    const row = await withTenant(db, orgA, async (tx) => {
      const [m] = await tx.select().from(messages).where(eq(messages.id, msg.id));
      return m!;
    });
    expect(row.revokedAt).not.toBeNull();
    expect(row.content).toEqual({ type: "text", text: "sigilo" });

    // Replay is idempotent — revoked_at is not restamped.
    const first = row.revokedAt;
    await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "message.revoked",
          messageExternalId: "false_v1@c.us_1",
        },
      }),
    );
    const replayed = await withTenant(db, orgA, async (tx) => {
      const [m] = await tx.select().from(messages).where(eq(messages.id, msg.id));
      return m!;
    });
    expect(replayed.revokedAt).toEqual(first);
  });
});

describe("contact.presence ingest", () => {
  it("resolves the active ticket and writes nothing", async () => {
    await newMessage("p1@c.us", "false_p1@c.us_1", "oi");
    const result = await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "contact.presence",
          chatId: "p1@c.us",
          participant: "p1@c.us",
          presence: "typing",
        },
      }),
    );
    expect(result).toEqual({ eventType: "contact.presence", messageId: null });
  });

  it("drops presence for chats without an active ticket", async () => {
    const result = await withTenant(db, orgA, (tx) =>
      ingestChannelEvent(tx, connA, {
        event: {
          type: "contact.presence",
          chatId: "ghost@c.us",
          participant: null,
          presence: "recording",
        },
      }),
    );
    expect(result.messageId).toBeNull();
  });
});

// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { TenantContext } from "@crm/core";
import { createLlmCredential } from "@crm/core/ai";
import type { ConnectionRef } from "@crm/core/messaging";
import { getMessage, ingestChannelEvent } from "@crm/core/messaging";
import type { Database } from "@crm/db";
import { createDb, schema, sql, withTenant } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { transcribeAudioHandler } from "./transcribe-audio";

const {
  aiUsageEvents,
  channelConnections,
  organizationMembers,
  organizationSettings,
  organizations,
  users,
} = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;
let connB: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

/** Ingests one inbound audio message and returns its message id. */
async function ingestAudio(org: string, conn: ConnectionRef, chatId: string): Promise<string> {
  const mediaContent = {
    type: "media" as const,
    mediaKind: "audio" as const,
    source: { type: "url" as const, url: "https://waha.example.com/files/audio.ogg" },
    mimeType: "audio/ogg; codecs=opus",
  };
  const messageId = await withTenant(db, org, async (tx) => {
    const result = await ingestChannelEvent(tx, conn, {
      event: {
        type: "message.received",
        externalMessageId: `stt_${chatId}`,
        from: { channelUserId: chatId, displayName: "Cliente" },
        content: mediaContent,
        timestamp: new Date(),
      },
    });
    return result.messageId;
  });
  expect(messageId).toBeTruthy();
  return messageId!;
}

const fakeProvider = {
  fetchMedia: () => Promise.resolve({ body: new Uint8Array([1, 2, 3]), contentType: "audio/ogg" }),
} as never;
const fakeTranscribe = () => Promise.resolve({ text: "oi, queria saber o preço" });

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
    .values({ name: "IT STT", email: `it-stt-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  for (const [name, slug] of [
    ["STT IT A", `stt-a-${suffix}`],
    ["STT IT B", `stt-b-${suffix}`],
  ] as const) {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug })
      .returning({ id: organizations.id });
    if (name.endsWith("A")) orgA = org!.id;
    else orgB = org!.id;
    await db.insert(organizationMembers).values({
      organizationId: org!.id,
      userId,
      role: "admin",
    });
  }
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT STT WAHA A",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-stt-a-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgA, kind: row!.kind };
  });
  connB = await withTenant(db, orgB, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgB,
        kind: "waha",
        name: "IT STT WAHA B",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-stt-b-${suffix}`,
      })
      .returning();
    return { id: row!.id, organizationId: orgB, kind: row!.kind };
  });
}, 60_000);

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} = ${userId}`);
  await db.$client.end();
});

describe("transcribeAudioHandler", () => {
  it("skips silently when the org has no audio-capable credential", async () => {
    const messageId = await ingestAudio(orgA, connA, "stt-nokey@c.us");
    const result = await transcribeAudioHandler(
      { organizationId: orgA, messageId, channelConnectionId: connA.id },
      { provider: fakeProvider, transcribe: fakeTranscribe },
    );
    expect(result.skipped).toBe(true);
  });

  it("writes metadata.transcript and records an stt usage event", async () => {
    const messageId = await ingestAudio(orgB, connB, "stt-keyed@c.us");
    await createLlmCredential(db, ctx(orgB, "admin"), {
      provider: "openai",
      apiKey: "sk-stt-test",
      model: "gpt-5-mini",
      priority: 0,
      label: "test",
      zdr: false,
    });

    const result = await transcribeAudioHandler(
      { organizationId: orgB, messageId, channelConnectionId: connB.id },
      { provider: fakeProvider, transcribe: fakeTranscribe },
    );
    expect(result.ok).toBe(true);

    const stored = await withTenant(db, orgB, (tx) => getMessage(tx, messageId));
    const metadata = stored!.metadata as Record<string, unknown>;
    expect(metadata.transcript).toBe("oi, queria saber o preço");

    const usage = await withTenant(db, orgB, (tx) =>
      tx
        .select()
        .from(aiUsageEvents)
        .where(sql`${aiUsageEvents.callKind} = 'stt'`),
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]!.status).toBe("ok");
  });

  it("is a no-op when the org disabled ai_transcribe_audio", async () => {
    const messageId = await ingestAudio(orgB, connB, "stt-off@c.us");
    await withTenant(db, orgB, (tx) =>
      tx
        .insert(organizationSettings)
        .values({ organizationId: orgB, aiTranscribeAudio: false })
        .onConflictDoUpdate({
          target: organizationSettings.organizationId,
          set: { aiTranscribeAudio: false },
        }),
    );
    try {
      const result = await transcribeAudioHandler(
        { organizationId: orgB, messageId, channelConnectionId: connB.id },
        { provider: fakeProvider, transcribe: fakeTranscribe },
      );
      expect(result.skipped).toBe(true);
      const stored = await withTenant(db, orgB, (tx) => getMessage(tx, messageId));
      expect((stored!.metadata as Record<string, unknown>).transcript).toBeUndefined();
    } finally {
      await withTenant(db, orgB, (tx) =>
        tx
          .update(organizationSettings)
          .set({ aiTranscribeAudio: true })
          .where(sql`${organizationSettings.organizationId} = ${orgB}`),
      );
    }
  });

  it("skips non-audio messages", async () => {
    const messageId = await withTenant(db, orgB, async (tx) => {
      const result = await ingestChannelEvent(tx, connB, {
        event: {
          type: "message.received",
          externalMessageId: "stt_text@c.us",
          from: { channelUserId: "stt-text@c.us" },
          content: { type: "text", text: "só texto" },
          timestamp: new Date(),
        },
      });
      return result.messageId;
    });
    const result = await transcribeAudioHandler(
      { organizationId: orgB, messageId: messageId!, channelConnectionId: connB.id },
      { provider: fakeProvider, transcribe: fakeTranscribe },
    );
    expect(result.skipped).toBe(true);
  });
});

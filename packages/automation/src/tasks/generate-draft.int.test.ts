// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { TenantContext } from "@crm/core";
import { findAgentByKind } from "@crm/core/agents";
import { createLlmCredential } from "@crm/core/ai";
import { listThreadCards } from "@crm/core/drafts";
import type { ConnectionRef } from "@crm/core/messaging";
import { ingestChannelEvent } from "@crm/core/messaging";
import type { Database } from "@crm/db";
import { createDb, schema, sql, withTenant } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateDraftHandler } from "./generate-draft";

const {
  aiUsageEvents,
  channelConnections,
  conversations,
  organizationMembers,
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

async function openConversation(
  target: { org: string; conn: ConnectionRef },
  chatId: string,
  messageCount = 1,
) {
  const { org, conn } = target;
  for (let i = 1; i <= messageCount; i++) {
    await withTenant(db, org, (tx) =>
      ingestChannelEvent(tx, conn, {
        type: "message.received",
        externalMessageId: `draft_${chatId}_${i}`,
        from: { channelUserId: chatId, displayName: "Cliente" },
        content: {
          type: "text",
          text: messageCount > 1 ? `msg ${i}` : "qual o prazo de entrega?",
        },
        // Distinct timestamps pin a deterministic transcript order.
        timestamp: messageCount > 1 ? new Date(Date.UTC(2024, 0, 1, 0, 0, i)) : new Date(),
      }),
    );
  }
  return withTenant(db, org, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(sql`${conversations.externalId} = ${chatId}`)
      .orderBy(sql`${conversations.createdAt} desc`)
      .limit(1);
    return conv!.id;
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
    .values({ name: "IT Drafter", email: `it-drafter-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  for (const [name, slug] of [
    ["Drafter IT A", `draf-a-${suffix}`],
    ["Drafter IT B", `draf-b-${suffix}`],
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
      role: name.endsWith("A") ? "agent" : "admin",
    });
  }
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT Draft WAHA A",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-draftjob-a-${suffix}`,
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
        name: "IT Draft WAHA B",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-draftjob-b-${suffix}`,
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

const fakeDraft = () =>
  Promise.resolve({
    body: "Olá! Nosso prazo padrão é de 5 dias úteis. Posso confirmar seu pedido?",
    rationale: "Responde a pergunta do cliente com o prazo padrão.",
    tokensIn: 100,
    tokensOut: 30,
  });

describe("generateDraftHandler", () => {
  it("skips silently when the org has no LLM credential", async () => {
    const convId = await openConversation({ org: orgA, conn: connA }, "nokey-draft@c.us");
    const result = await generateDraftHandler({
      organizationId: orgA,
      conversationId: convId,
      mode: "suggest",
    });
    expect(result.skipped).toBe(true);
    expect(result.drafted).toBe(false);
  });

  it("persists a pending draft, records usage, lazily creates the drafter agent", async () => {
    const convId = await openConversation({ org: orgB, conn: connB }, "keyed-draft@c.us");
    await createLlmCredential(db, ctx(orgB, "admin"), {
      provider: "openrouter",
      apiKey: "sk-or-draft-test",
      model: "openai/gpt-5-mini",
      priority: 0,
      label: "test",
      zdr: true,
    });

    const result = await generateDraftHandler(
      { organizationId: orgB, conversationId: convId, mode: "suggest" },
      { draft: fakeDraft },
    );
    expect(result.drafted).toBe(true);

    const pending = await listThreadCards(db, ctx(orgB, "admin"), convId);
    expect(pending).toHaveLength(1);
    expect((pending[0]!.payload as { body: string }).body).toContain("5 dias úteis");

    const drafter = await withTenant(db, orgB, (tx) => findAgentByKind(tx, orgB, "drafter"));
    expect(drafter).toBeDefined();

    const usage = await withTenant(db, orgB, (tx) =>
      tx
        .select()
        .from(aiUsageEvents)
        .where(sql`${aiUsageEvents.callKind} = 'draft'`),
    );
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0]!.tokensIn).toBe(100);
  });

  it("regeneration supersedes the previous pending draft", async () => {
    const convId = await openConversation({ org: orgB, conn: connB }, "regen-draft@c.us");

    await generateDraftHandler(
      { organizationId: orgB, conversationId: convId, mode: "suggest" },
      { draft: fakeDraft },
    );
    await generateDraftHandler(
      { organizationId: orgB, conversationId: convId, mode: "suggest" },
      {
        draft: () =>
          Promise.resolve({
            body: "Nova versão do rascunho.",
            rationale: "regenerado",
            tokensIn: 50,
            tokensOut: 10,
          }),
      },
    );

    const pending = await listThreadCards(db, ctx(orgB, "admin"), convId);
    expect(pending).toHaveLength(1);
    expect((pending[0]!.payload as { body: string }).body).toBe("Nova versão do rascunho.");
  });

  it("sends the 40 most recent messages as the transcript, not the first 40", async () => {
    const convId = await openConversation({ org: orgB, conn: connB }, "tail-draft@c.us", 45);
    let transcript: string[] = [];
    await generateDraftHandler(
      { organizationId: orgB, conversationId: convId, mode: "suggest" },
      {
        draft: (input) => {
          transcript = input.transcript.map((m) => m.text);
          return fakeDraft();
        },
      },
    );
    expect(transcript).toHaveLength(40);
    expect(transcript[0]).toBe("msg 6");
    expect(transcript.at(-1)).toBe("msg 45");
  });
});

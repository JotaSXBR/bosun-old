// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { TenantContext } from "@crm/core";
import { createLlmCredential } from "@crm/core/ai";
import { createDraftSuggestion } from "@crm/core/drafts";
import type { ConnectionRef } from "@crm/core/messaging";
import { ingestChannelEvent, resolveConversation } from "@crm/core/messaging";
import { updateObserverSettings } from "@crm/core/organizations";
import { listAgentSuggestions } from "@crm/core/suggestions";
import type { Database } from "@crm/db";
import { createDb, schema, sql, withTenant } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { observerAnalyzeHandler } from "./observer-analyze";

const { channelConnections, conversations, organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let userId: string;
let connA: ConnectionRef;
let connB: ConnectionRef;

function ctx(organizationId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

async function resolvedConversation(org: string, conn: ConnectionRef, chatId: string) {
  await withTenant(db, org, (tx) =>
    ingestChannelEvent(tx, conn, {
      event: {
        type: "message.received",
        externalMessageId: `obs_${chatId}_1`,
        from: { channelUserId: chatId, displayName: "Cliente" },
        content: { type: "text", text: "qual o prazo de entrega?" },
        timestamp: new Date(),
      },
    }),
  );
  const ticket = await withTenant(db, org, async (tx) => {
    const [conv] = await tx
      .select()
      .from(conversations)
      .where(sql`${conversations.externalId} = ${chatId}`)
      .orderBy(sql`${conversations.createdAt} desc`)
      .limit(1);
    return conv!;
  });
  await resolveConversation(db, ctx(org, "admin"), { input: { conversationId: ticket.id } });
  return ticket.id;
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
    .values({ name: "IT Observer", email: `it-observer-${suffix}@crm.local` })
    .returning({ id: users.id });
  userId = user!.id;
  for (const [name, slug] of [
    ["Observer IT A", `obs-a-${suffix}`],
    ["Observer IT B", `obs-b-${suffix}`],
  ] as const) {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug })
      .returning({ id: organizations.id });
    if (name.endsWith("A")) orgA = org!.id;
    else orgB = org!.id;
    await db.insert(organizationMembers).values({ organizationId: org!.id, userId, role: "admin" });
  }
  connA = await withTenant(db, orgA, async (tx) => {
    const [row] = await tx
      .insert(channelConnections)
      .values({
        organizationId: orgA,
        kind: "waha",
        name: "IT WAHA A",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-obs-a-${suffix}`,
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
        name: "IT WAHA B",
        credentialsEncrypted: "not-used",
        webhookToken: `tok-obs-b-${suffix}`,
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

const fakeAnalyze = () =>
  Promise.resolve({
    suggestions: [
      {
        targetType: "knowledge_entry" as const,
        payload: { title: "Prazo", content: "5 dias úteis" },
        rationale: "Cliente perguntou prazo",
      },
    ],
    memories: [],
    tokensIn: 42,
    tokensOut: 7,
  });

const fakeAnalyzeWithMemories = () =>
  Promise.resolve({
    suggestions: [],
    memories: [
      {
        type: "pattern" as const,
        scope: "contact" as const,
        content: "Este contato prefere respostas curtas.",
        confidence: "medium" as const,
        staleAfterDays: 90,
        rationale: "Contato pediu objetividade duas vezes",
      },
      {
        // Dropped — low confidence never reaches the inbox.
        type: "metric" as const,
        scope: "org" as const,
        content: "Talvez ticket médio alto.",
        confidence: "low" as const,
        staleAfterDays: 30,
        rationale: "evidência fraca",
      },
      {
        // Dropped — team scope but the conversation has no sector.
        type: "procedure" as const,
        scope: "team" as const,
        content: "Procedimento de equipe.",
        confidence: "high" as const,
        staleAfterDays: 90,
        rationale: "sem setor para vincular",
      },
    ],
    tokensIn: 10,
    tokensOut: 5,
  });

describe("observerAnalyzeHandler", () => {
  it("skips silently when the org has no LLM credential", async () => {
    const convId = await resolvedConversation(orgA, connA, "nokey@c.us");
    const result = await observerAnalyzeHandler({
      organizationId: orgA,
      conversationId: convId,
    });
    expect(result.skipped).toBe(true);
    expect(result.suggestions).toBe(0);
  });

  it("persists pending suggestions and records usage; re-run dedupes", async () => {
    const convId = await resolvedConversation(orgB, connB, "keyed@c.us");
    await createLlmCredential(db, ctx(orgB, "admin"), {
      provider: "openrouter",
      apiKey: "sk-or-test",
      model: "openai/gpt-5-mini",
      priority: 0,
      label: "test",
      zdr: true,
    });

    const result = await observerAnalyzeHandler(
      { organizationId: orgB, conversationId: convId },
      { analyze: fakeAnalyze },
    );
    expect(result.analyzed).toBe(true);
    expect(result.suggestions).toBe(1);

    const pending = await listAgentSuggestions(db, ctx(orgB, "admin"), { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sourceConversationId).toBe(convId);
    expect(pending[0]?.rationale).toContain("prazo");

    // A second run sees the pending suggestion and skips the LLM call.
    const again = await observerAnalyzeHandler(
      { organizationId: orgB, conversationId: convId },
      { analyze: fakeAnalyze },
    );
    expect(again.skipped).toBe(true);
  });

  it("stages memory proposals bound to the conversation's scope refs", async () => {
    const convId = await resolvedConversation(orgA, connA, "memory@c.us");
    await createLlmCredential(db, ctx(orgA, "admin"), {
      provider: "openrouter",
      apiKey: "sk-or-test-2",
      model: "openai/gpt-5-mini",
      priority: 0,
      label: "test",
      zdr: true,
    });

    const result = await observerAnalyzeHandler(
      { organizationId: orgA, conversationId: convId },
      { analyze: fakeAnalyzeWithMemories },
    );
    expect(result.analyzed).toBe(true);
    // Only the contact-scoped medium-confidence memory survives filtering.
    expect(result.suggestions).toBe(1);

    const pending = await listAgentSuggestions(db, ctx(orgA, "admin"), { status: "pending" });
    const memory = pending.find((s) => s.targetType === "memory");
    expect(memory).toBeDefined();
    const payload = memory!.payload as { scope: string; contactId?: string; content: string };
    expect(payload.scope).toBe("contact");
    // contactId was bound from the conversation, not invented by the model.
    const [conv] = await withTenant(db, orgA, (tx) =>
      tx
        .select({ contactId: conversations.contactId })
        .from(conversations)
        .where(sql`${conversations.id} = ${convId}`),
    );
    expect(payload.contactId).toBe(conv!.contactId);
    expect(memory!.sourceConversationId).toBe(convId);
  });

  it("a pending draft does not block the analysis pass", async () => {
    const convId = await resolvedConversation(orgB, connB, "draftpending@c.us");
    await createDraftSuggestion(db, orgB, {
      conversationId: convId,
      payload: { body: "Olá! Posso ajudar?" },
      rationale: "saudação",
    });
    const result = await observerAnalyzeHandler(
      { organizationId: orgB, conversationId: convId },
      { analyze: fakeAnalyze },
    );
    expect(result.analyzed).toBe(true);
  });

  it("observer-mode gate: 'off'/'interval' skip the on_close path, force bypasses", async () => {
    const convId = await resolvedConversation(orgA, connA, "gated@c.us");
    const admin = ctx(orgA, "admin");
    const defaults = {
      observerIntervalMinutes: 15,
      observerIdleMinutes: 15,
      observerAutoDraft: false,
    };

    await updateObserverSettings(db, admin, { aiObserverMode: "off", ...defaults });
    const off = await observerAnalyzeHandler(
      { organizationId: orgA, conversationId: convId },
      { analyze: fakeAnalyze },
    );
    expect(off.skipped).toBe(true);
    expect(off.analyzed).toBe(false);

    await updateObserverSettings(db, admin, { aiObserverMode: "interval", ...defaults });
    const interval = await observerAnalyzeHandler(
      { organizationId: orgA, conversationId: convId },
      { analyze: fakeAnalyze },
    );
    expect(interval.skipped).toBe(true);

    // Manual "analisar agora" is a conscious spend — force bypasses the gate.
    const forced = await observerAnalyzeHandler(
      { organizationId: orgA, conversationId: convId, force: true },
      { analyze: fakeAnalyze },
    );
    expect(forced.analyzed).toBe(true);

    await updateObserverSettings(db, admin, { aiObserverMode: "on_close", ...defaults });
  });
});

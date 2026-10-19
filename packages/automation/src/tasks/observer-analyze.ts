import type { ObserverInput, ObserverResult } from "@crm/ai";
import { listAgentRows, modelRefSchema } from "@crm/core/agents";
import { resolveOrgLlmCredentials } from "@crm/core/ai";
import { listCanonEntries } from "@crm/core/brain";
import { findOrCreateObserver, THREAD_CARD_TARGET_TYPES } from "@crm/core/drafts";
import { listKnowledgeRows } from "@crm/core/knowledge";
import { getConversationRow, listConversations, listRecentMessages } from "@crm/core/messaging";
import { findSettings } from "@crm/core/organizations";
import { listPendingByTargetType, listPendingForConversation } from "@crm/core/suggestions";
import type { Database } from "@crm/db";
import { getDb, withTenant } from "@crm/db";
import { z } from "zod";

import { runCredentialAttempt } from "./observer-attempt";

export const observerAnalyzePayload = z.object({
  organizationId: z.uuid(),
  /** Resolved conversation to analyze; absent → latest resolved (manual trigger). */
  conversationId: z.uuid().optional(),
  /** Who clicked "analyze now" — identity only, never trusted for auth. */
  actorUserId: z.uuid().optional(),
  /** Manual "analyze now" — bypasses the observer-mode gate (conscious click). */
  force: z.boolean().optional(),
});

export type ObserverAnalyzePayload = z.infer<typeof observerAnalyzePayload>;

/** Resolved-conversation transcripts are capped — long history is a cost knob. */
const TRANSCRIPT_LIMIT = 100;
const MANUAL_CANDIDATES = 3;

async function pickConversationId(
  db: Database,
  organizationId: string,
  conversationId: string | undefined,
): Promise<string | null> {
  if (conversationId) return conversationId;
  const resolved = await listConversations(db, organizationId, {
    view: "closed",
    limit: MANUAL_CANDIDATES,
    userId: "",
  });
  for (const conv of resolved) {
    const pending = await withTenant(db, organizationId, (tx) =>
      listPendingForConversation(tx, organizationId, conv.id),
    );
    if (pending.length === 0) return conv.id;
  }
  return null;
}

export type ObserverAnalyzeDeps = {
  /** LLM call — injectable so tests don't hit a real provider. */
  analyze?: (input: ObserverInput) => Promise<ObserverResult>;
};

const SKIPPED = { analyzed: false, suggestions: 0, skipped: true } as const;

/**
 * Observer-mode gate (docs/product/ai-agents.md): post-resolve analysis
 * runs on `on_close` (and `realtime` when it ships); `interval` orgs get
 * nudges from observer-scan instead; `off` runs nothing. A manual
 * trigger (force) always runs — the click is a conscious spend. Returns
 * the conversation to analyze, or null to skip.
 */
async function resolveTarget(db: Database, parsed: ObserverAnalyzePayload): Promise<string | null> {
  const { organizationId } = parsed;
  const mode = await withTenant(
    db,
    organizationId,
    async (tx) => (await findSettings(tx, organizationId))?.aiObserverMode ?? "on_close",
  );
  if (!parsed.force && mode !== "on_close" && mode !== "realtime") return null;
  return pickConversationId(db, organizationId, parsed.conversationId);
}

/** Brain context: canon entries relevant to this conversation + pending memory proposals for dedupe. */
function brainContext(
  canon: Awaited<ReturnType<typeof listCanonEntries>>,
  pendingMemory: Awaited<ReturnType<typeof listPendingByTargetType>>,
) {
  return {
    canon: canon.map((e) => ({
      id: e.id,
      type: e.type,
      scope: e.scope,
      content: e.content,
      confidence: e.confidence,
    })),
    pendingContents: pendingMemory
      .map((row) => (row.payload as { content?: string }).content ?? "")
      .filter((c) => c.length > 0),
  };
}

async function gather(db: Database, organizationId: string, conversationId: string) {
  return withTenant(db, organizationId, async (tx) => {
    const credentials = await resolveOrgLlmCredentials(tx, organizationId);
    if (credentials.length === 0) return null;
    const pending = (await listPendingForConversation(tx, organizationId, conversationId)).filter(
      // Drafts/nudges live on open threads — they must not block the
      // post-resolve analysis pass.
      (row) => !(THREAD_CARD_TARGET_TYPES as readonly string[]).includes(row.targetType),
    );
    if (pending.length > 0) return null;
    const agents = await listAgentRows(tx, organizationId);
    const knowledge = await listKnowledgeRows(tx, organizationId);
    const conversation = await getConversationRow(tx, conversationId);
    const canon = await listCanonEntries(tx, organizationId, {
      teamId: conversation?.sectorId ?? undefined,
      contactId: conversation?.contactId,
      limit: 15,
    });
    const pendingMemory = await listPendingByTargetType(tx, organizationId, "memory");
    return {
      credentials,
      agents,
      knowledge,
      teamId: conversation?.sectorId ?? null,
      contactId: conversation?.contactId ?? null,
      brain: brainContext(canon, pendingMemory),
    };
  });
}

type Gathered = NonNullable<Awaited<ReturnType<typeof gather>>>;

function toAnalysisInput(
  prepared: Gathered,
  messages: Awaited<ReturnType<typeof listRecentMessages>>,
) {
  const transcript = messages.map((m) => {
    const content = m.content as { text?: string; caption?: string; type?: string };
    return {
      direction: m.direction as "inbound" | "outbound",
      text: content.text ?? content.caption ?? `[${content.type ?? "media"}]`,
      private: m.private,
    };
  });
  const agents = prepared.agents.map((a) => ({
    id: a.id,
    name: a.name,
    specialty: a.specialty,
    status: a.status,
    systemPrompt: a.systemPrompt,
  }));
  const knowledge = prepared.knowledge
    .filter((k) => k.status === "active")
    .map((k) => ({ id: k.id, title: k.title }));
  return { transcript, agents, knowledge, brain: prepared.brain };
}

type ChainContext = {
  db: Database;
  organizationId: string;
  conversationId: string;
  prepared: Gathered;
  observer: Awaited<ReturnType<typeof findOrCreateObserver>>;
  messages: Awaited<ReturnType<typeof listRecentMessages>>;
  analyze: ObserverAnalyzeDeps["analyze"];
};

/** Credential fallback chain: first success wins, otherwise the last error is thrown. */
async function analyzeWithFallback(
  c: ChainContext,
): Promise<{ analyzed: true; suggestions: number }> {
  // The observer agent's modelRef overrides the credential's model when the
  // provider matches (a different provider's model can't use this key).
  const ref = modelRefSchema.safeParse(c.observer.modelRef);
  const observerModelRef = ref.success ? ref.data : null;
  const input = { ...toAnalysisInput(c.prepared, c.messages), analyze: c.analyze };
  let lastError: unknown;
  for (const cred of c.prepared.credentials) {
    const attempt = await runCredentialAttempt(
      {
        db: c.db,
        organizationId: c.organizationId,
        conversationId: c.conversationId,
        cred,
        teamId: c.prepared.teamId,
        contactId: c.prepared.contactId,
        observerModelRef,
        observerPersona: c.observer.systemPrompt,
      },
      input,
    );
    if (attempt.ok) return { analyzed: true, suggestions: attempt.suggestions };
    lastError = attempt.error;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * AI observer v1 — passive analysis of a resolved conversation. Emits
 * pending `agent_suggestions` only: never sends a customer message, never
 * drafts a reply. Organizations without an LLM credential are silently
 * skipped (BYOK is opt-in). Retries re-use the pending-suggestion dedupe,
 * so a re-run can't duplicate suggestions for the same target.
 */
export async function observerAnalyzeHandler(
  payload: unknown,
  deps?: ObserverAnalyzeDeps,
): Promise<{
  analyzed: boolean;
  suggestions: number;
  skipped?: boolean;
}> {
  const parsed = observerAnalyzePayload.parse(payload);
  const db = getDb();
  const { organizationId } = parsed;
  const conversationId = await resolveTarget(db, parsed);
  if (!conversationId) return SKIPPED;

  const prepared = await gather(db, organizationId, conversationId);
  if (!prepared) return SKIPPED;

  const [observer, messages] = await Promise.all([
    findOrCreateObserver(db, organizationId),
    listRecentMessages(db, organizationId, { conversationId, limit: TRANSCRIPT_LIMIT }),
  ]);
  return analyzeWithFallback({
    db,
    organizationId,
    conversationId,
    prepared,
    observer,
    messages,
    analyze: deps?.analyze,
  });
}

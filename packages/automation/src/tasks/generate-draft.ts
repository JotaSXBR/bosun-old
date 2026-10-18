import type { DraftInput } from "@crm/ai";
import { draftReply, resolveLanguageModel } from "@crm/ai";
import { llmProviderSchema, recordUsageEvents, resolveOrgLlmCredentials } from "@crm/core/ai";
import { listCanonEntries } from "@crm/core/brain";
import { createDraftSuggestion, findOrCreateDrafter } from "@crm/core/drafts";
import { getConversationRow, listRecentMessages } from "@crm/core/messaging";
import type { Database } from "@crm/db";
import { getDb, withTenant } from "@crm/db";
import { createLogger } from "@crm/observability";
import { z } from "zod";

import { keysFor } from "../llm-keys";

const logger = createLogger({ bindings: { component: "drafter" } });

export const generateDraftPayload = z.object({
  organizationId: z.uuid(),
  conversationId: z.uuid(),
  mode: z.enum(["suggest", "improve"]).default("suggest"),
  /** 'improve' rewrites this composer text instead of drafting from scratch. */
  sourceText: z.string().trim().min(1).max(4096).optional(),
  /** Who clicked — recorded as proposedBy; identity only, never trusted for auth. */
  requestedBy: z.uuid().optional(),
});

export type GenerateDraftPayload = z.infer<typeof generateDraftPayload>;

/** Draft context window — recent history, not the whole thread. */
const TRANSCRIPT_LIMIT = 40;
/** Lean brain core injected into the drafter prompt (see ai-agents spec). */
const BRAIN_CORE_LIMIT = 8;

export type GenerateDraftDeps = {
  /** LLM call — injectable so tests don't hit a real provider. */
  draft?: (input: DraftInput) => Promise<{
    body: string;
    rationale: string;
    tokensIn: number;
    tokensOut: number;
  }>;
};

type Credential = Awaited<ReturnType<typeof resolveOrgLlmCredentials>>[number];

type Prepared = {
  credentials: Credential[];
  draftInput: Omit<DraftInput, "model">;
};

/**
 * Tenant-scoped gather: credentials + conversation + brain core inside
 * one tx; transcript and the drafter agent use their own tenant contexts
 * (`listMessages`/`findOrCreateDrafter` take the db handle). Returns null
 * when there's nothing to do (no BYOK credential, conversation gone).
 */
async function prepare(db: Database, payload: GenerateDraftPayload): Promise<Prepared | null> {
  const { organizationId, conversationId, mode, sourceText } = payload;
  const base = await withTenant(db, organizationId, async (tx) => {
    const credentials = await resolveOrgLlmCredentials(tx, organizationId);
    if (credentials.length === 0) return null;
    const conversation = await getConversationRow(tx, conversationId);
    if (!conversation) return null;
    const canon = await listCanonEntries(tx, organizationId, {
      teamId: conversation.sectorId ?? undefined,
      contactId: conversation.contactId,
      limit: BRAIN_CORE_LIMIT,
    });
    return { credentials, canon };
  });
  if (!base) return null;

  const [drafter, messages] = await Promise.all([
    findOrCreateDrafter(db, organizationId),
    listRecentMessages(db, organizationId, conversationId, TRANSCRIPT_LIMIT),
  ]);
  return {
    credentials: base.credentials,
    draftInput: {
      drafter: {
        name: drafter.name,
        systemPrompt: drafter.systemPrompt,
        businessRules: drafter.businessRules,
      },
      transcript: messages.map((m) => {
        const content = m.content as { text?: string; caption?: string; type?: string };
        return {
          direction: m.direction as "inbound" | "outbound",
          text: content.text ?? content.caption ?? `[${content.type ?? "media"}]`,
          private: m.private,
        };
      }),
      brain: {
        canon: base.canon.map((e) => ({
          id: e.id,
          type: e.type,
          scope: e.scope,
          content: e.content,
          confidence: e.confidence,
        })),
        pendingContents: [],
      },
      mode,
      sourceText,
    },
  };
}

type AttemptCtx = {
  db: Database;
  organizationId: string;
  conversationId: string;
  /** Who asked for the generation — lands on the row as proposedBy. */
  requestedBy?: string;
  draftInput: Omit<DraftInput, "model">;
  draft: NonNullable<GenerateDraftDeps["draft"]>;
};

/**
 * One credential attempt: model → draft → usage → persist the pending
 * suggestion. Throws so the caller can fall through to the next
 * credential (BYOK fallback chain).
 */
async function attempt(ctx: AttemptCtx, cred: Credential): Promise<void> {
  const { db, organizationId, conversationId } = ctx;
  const startedAt = Date.now();
  const record = (status: "ok" | "error", tokensIn = 0, tokensOut = 0) =>
    withTenant(db, organizationId, (tx) =>
      recordUsageEvents(tx, organizationId, [
        {
          credentialId: cred.id,
          callKind: "draft",
          provider: cred.provider,
          model: cred.model,
          tokensIn,
          tokensOut,
          latencyMs: Date.now() - startedAt,
          status,
        },
      ]),
    );
  try {
    const model = resolveLanguageModel(
      {
        provider: llmProviderSchema.parse(cred.provider),
        modelId: cred.model,
        routing: { zdr: cred.zdr, sessionId: conversationId },
      },
      keysFor(cred),
    );
    const result = await ctx.draft({ ...ctx.draftInput, model });
    // Persist the paid-for draft first — a usage-record failure must not
    // discard it (best-effort, same as the error path below).
    await createDraftSuggestion(db, organizationId, {
      conversationId,
      payload: { body: result.body },
      rationale: result.rationale,
      proposedBy: ctx.requestedBy,
    });
    await record("ok", result.tokensIn, result.tokensOut).catch((usageError: unknown) =>
      logger.warn("usage record failed", { error: String(usageError) }),
    );
  } catch (error) {
    await record("error").catch((usageError: unknown) =>
      logger.warn("usage record failed", { error: String(usageError) }),
    );
    throw error;
  }
}

/** Tries each credential in order; the first success wins, otherwise the last error is thrown. */
async function tryCredentials(ctx: AttemptCtx, credentials: Credential[]): Promise<void> {
  let lastError: unknown;
  for (const cred of credentials) {
    try {
      await attempt(ctx, cred);
      return;
    } catch (error) {
      logger.warn("draft credential attempt failed", {
        organizationId: ctx.organizationId,
        provider: cred.provider,
        model: cred.model,
        error: error instanceof Error ? error.message : String(error),
      });
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Generates one pending draft suggestion for a conversation. Runs the
 * org's drafter agent config (lazy-created on first use) over the recent
 * transcript + brain core; every attempt records `ai_usage_events` with
 * callKind "draft". No org LLM credential → silently skipped (BYOK
 * opt-in). The new draft supersedes any pending one — at most one
 * pending draft per conversation.
 */
export async function generateDraftHandler(
  payload: unknown,
  deps?: GenerateDraftDeps,
): Promise<{ drafted: boolean; skipped?: boolean }> {
  const parsed = generateDraftPayload.parse(payload);
  const db = getDb();
  const prepared = await prepare(db, parsed);
  if (!prepared) {
    return { drafted: false, skipped: true };
  }

  const attemptCtx: AttemptCtx = {
    db,
    organizationId: parsed.organizationId,
    conversationId: parsed.conversationId,
    requestedBy: parsed.requestedBy,
    draftInput: prepared.draftInput,
    draft: deps?.draft ?? draftReply,
  };
  await tryCredentials(attemptCtx, prepared.credentials);
  return { drafted: true };
}

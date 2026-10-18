import type { ObserverInput, ObserverResult } from "@crm/ai";
import { analyzeConversation, resolveLanguageModel } from "@crm/ai";
import { llmProviderSchema, recordUsageEvents } from "@crm/core/ai";
import { memoryProposalSchema } from "@crm/core/brain";
import { createSystemSuggestions } from "@crm/core/suggestions";
import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";
import { createLogger } from "@crm/observability";
import type { z } from "zod";

import { keysFor } from "../llm-keys";

const logger = createLogger({ bindings: { component: "observer" } });

type Credential = {
  id: string;
  provider: string;
  apiKey: string;
  model: string;
  zdr: boolean;
};

export type AttemptScope = {
  db: Database;
  organizationId: string;
  conversationId: string;
  cred: Credential;
  teamId: string | null;
  contactId: string | null;
  /** Observer agent's modelRef — overrides the credential model on provider match. */
  observerModelRef: { provider: string; modelId: string } | null;
  observerPersona: string;
};
export type AttemptInput = Omit<ObserverInput, "model" | "observerPersona"> & {
  analyze?: (input: ObserverInput) => Promise<ObserverResult>;
};

const logUsageFailure = (organizationId: string) => (usageError: unknown) =>
  logger.warn("observer usage record failed", {
    organizationId,
    error: usageError instanceof Error ? usageError.message : String(usageError),
  });

function usageRecorder(scope: AttemptScope, model: string) {
  const startedAt = Date.now();
  return (status: "ok" | "error", tokensIn = 0, tokensOut = 0) =>
    withTenant(scope.db, scope.organizationId, (tx) =>
      recordUsageEvents(tx, scope.organizationId, [
        {
          credentialId: scope.cred.id,
          callKind: "observer",
          provider: scope.cred.provider,
          model,
          tokensIn,
          tokensOut,
          latencyMs: Date.now() - startedAt,
          status,
        },
      ]),
    );
}

async function analyzeAndStore(
  scope: AttemptScope,
  input: AttemptInput,
  target: { provider: z.infer<typeof llmProviderSchema>; modelId: string },
) {
  const { db, organizationId, conversationId, cred } = scope;
  const model = resolveLanguageModel(
    { ...target, routing: { zdr: cred.zdr, sessionId: conversationId } },
    keysFor(cred),
  );
  const { transcript, agents, knowledge, brain, analyze } = input;
  const result = await (analyze ?? analyzeConversation)({
    model,
    transcript,
    agents,
    knowledge,
    brain,
    observerPersona: scope.observerPersona,
  });
  // Persist the paid-for suggestions first — a usage-record failure must
  // not discard them (best-effort, same as the error path below).
  const created = await createSystemSuggestions(db, organizationId, [
    ...result.suggestions.map((s) => ({
      ...s,
      targetId: s.targetId ?? null,
      sourceConversationId: conversationId,
    })),
    ...memorySuggestionInputs(
      result,
      { conversationId, teamId: scope.teamId, contactId: scope.contactId },
      organizationId,
    ),
  ]);
  return { suggestions: created.length, tokensIn: result.tokensIn, tokensOut: result.tokensOut };
}

/** The observer agent's modelRef wins over the credential's model when the provider matches. */
function modelTarget(scope: AttemptScope) {
  const provider = llmProviderSchema.parse(scope.cred.provider);
  const ref = scope.observerModelRef;
  return { provider, modelId: ref?.provider === provider ? ref.modelId : scope.cred.model };
}

/** One credential in the fallback chain — records usage on both outcomes. */
export async function runCredentialAttempt(
  scope: AttemptScope,
  input: AttemptInput,
): Promise<{ ok: true; suggestions: number } | { ok: false; error: unknown }> {
  const target = modelTarget(scope);
  const record = usageRecorder(scope, target.modelId);
  try {
    const out = await analyzeAndStore(scope, input, target);
    await record("ok", out.tokensIn, out.tokensOut).catch(logUsageFailure(scope.organizationId));
    return { ok: true, suggestions: out.suggestions };
  } catch (error) {
    logger.warn("observer credential attempt failed", {
      organizationId: scope.organizationId,
      provider: scope.cred.provider,
      model: scope.cred.model,
      error: error instanceof Error ? error.message : String(error),
    });
    await record("error").catch(logUsageFailure(scope.organizationId));
    return { ok: false, error };
  }
}

/**
 * Memory proposals → suggestion inputs. Scope refs come from the
 * conversation (never from the model): team scope binds `sectorId`,
 * contact scope binds `contactId`. Proposals that can't satisfy their
 * scope (e.g. team on a teamless conversation) or carry `low` confidence
 * are dropped — review-inbox hygiene beats recall here.
 */
function memorySuggestionInputs(
  result: ObserverResult,
  refs: { conversationId: string; teamId: string | null; contactId: string | null },
  organizationId: string,
): Array<{
  targetType: "memory";
  payload: Record<string, unknown>;
  rationale: string;
  sourceConversationId: string;
}> {
  return result.memories
    .filter((m) => m.confidence !== "low")
    .flatMap((m) => {
      const candidate = memoryProposalSchema.safeParse({
        type: m.type,
        scope: m.scope,
        teamId: m.scope === "team" ? refs.teamId : null,
        contactId: m.scope === "contact" ? refs.contactId : null,
        content: m.content,
        confidence: m.confidence,
        staleAfterDays: m.staleAfterDays,
        supersedes: m.supersedes ?? null,
        sourceConversationIds: [refs.conversationId],
      });
      if (!candidate.success) {
        logger.warn("observer memory proposal dropped", {
          organizationId,
          conversationId: refs.conversationId,
          scope: m.scope,
          reason: candidate.error.issues[0]?.message ?? "invalid payload",
        });
        return [];
      }
      return [
        {
          targetType: "memory" as const,
          payload: candidate.data,
          rationale: m.rationale,
          sourceConversationId: refs.conversationId,
        },
      ];
    });
}

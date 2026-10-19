import type { ChannelProvider } from "@crm/channels";
import type { Database } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";
import type { z } from "zod";

import { DomainError, NotFoundError } from "../../errors";
import { isUniqueViolation } from "../../lib/pg-error";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { recordAuditEvent } from "../audit";
import { sendOutboundMessage } from "../messaging";
import type { AgentSuggestionRow } from "../suggestions";
import { findSuggestionById, insertSuggestion, markSuggestionReviewed } from "../suggestions";
import {
  claimPendingDraft,
  DRAFT_TARGET_TYPE,
  listPendingThreadCards,
  NUDGE_TARGET_TYPE,
  releaseDraftClaim,
  supersedePendingThreadCards,
} from "./repository";
import type { DraftPayload, ReviewNudgeInput } from "./schemas";
import { draftPayloadSchema, requestDraftInput, reviewNudgeInput } from "./schemas";

/** Audit is post-commit best-effort — a logging failure must not fail the mutation. */
function audit(
  db: Database,
  ctx: TenantContext,
  { action, id: suggestionId }: { action: string; id: string },
): void {
  recordAuditEvent(db, ctx, {
    action,
    targetType: "agent_suggestion",
    targetId: suggestionId,
    metadata: { suggestionId, targetType: DRAFT_TARGET_TYPE },
  }).catch((error: unknown) => captureException(error, { module: "drafts", action }));
}

function assertDraftRow(suggestion: AgentSuggestionRow | null): AgentSuggestionRow {
  if (suggestion?.targetType !== DRAFT_TARGET_TYPE) {
    throw new NotFoundError("Draft", suggestion?.id ?? "?");
  }
  return suggestion;
}

/** Post-claim read for an approve that lost the pending-slot race. */
async function reviewedDraftState(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<AgentSuggestionRow> {
  const current = assertDraftRow(
    await withTenant(db, ctx.organizationId, (tx) =>
      findSuggestionById(tx, ctx.organizationId, suggestionId),
    ),
  );
  if (current.status === "approved") return current;
  throw new DomainError("DRAFT_ALREADY_REVIEWED", current.status);
}

/** Requires messaging:write — viewers never see thread cards (drafts or nudges). */
export async function listThreadCards(
  db: Database,
  ctx: TenantContext,
  conversationId: string,
): Promise<AgentSuggestionRow[]> {
  assertPermission(ctx, { messaging: ["write"] });
  return withTenant(db, ctx.organizationId, (tx) =>
    listPendingThreadCards(tx, ctx.organizationId, conversationId),
  );
}

/** Unique-violation fallback — return the winner's pending card. */
async function pendingThreadCard(
  db: Database,
  organizationId: string,
  conversationId: string,
): Promise<AgentSuggestionRow | null> {
  const [existing] = await withTenant(db, organizationId, (tx) =>
    listPendingThreadCards(tx, organizationId, conversationId),
  );
  return existing ?? null;
}

/**
 * System path — the generate-draft job calls this after the LLM run.
 * Supersedes any pending draft for the conversation, then inserts the new
 * one and emits the SSE event the inbox listens to.
 */
export async function createDraftSuggestion(
  db: Database,
  organizationId: string,
  input: {
    conversationId: string;
    payload: DraftPayload;
    rationale: string;
    /** Who asked for the generation — null means a system enqueue. */
    proposedBy?: string | null;
  },
): Promise<AgentSuggestionRow> {
  const payload = draftPayloadSchema.parse(input.payload);
  try {
    return await withTenant(db, organizationId, async (tx) => {
      await supersedePendingThreadCards(tx, organizationId, input.conversationId);
      const row = await insertSuggestion(tx, {
        organizationId,
        targetType: DRAFT_TARGET_TYPE,
        payload,
        rationale: input.rationale,
        sourceConversationId: input.conversationId,
        proposedBy: input.proposedBy ?? null,
      });
      await emitDomainEvent(tx, {
        type: "agent_suggestion.created",
        organizationId,
        suggestionId: row.id,
        conversationId: input.conversationId,
        targetType: DRAFT_TARGET_TYPE,
      });
      return row;
    });
  } catch (error) {
    // Concurrent generation won the pending-slot race — return its row
    // instead of surfacing a constraint error to the caller.
    if (!isUniqueViolation(error)) throw error;
    const existing = await pendingThreadCard(db, organizationId, input.conversationId);
    if (!existing) throw error;
    return existing;
  }
}

/**
 * System path — the observer-scan job calls this when the deterministic
 * predicate fires (assigned human idle past the threshold, last message
 * inbound). The nudge card carries no reply text; its "Gerar" action
 * produces a real draft on demand.
 */
export async function createNudgeSuggestion(
  db: Database,
  organizationId: string,
  input: { conversationId: string; rationale: string; idleMinutes?: number },
): Promise<AgentSuggestionRow> {
  try {
    return await withTenant(db, organizationId, async (tx) => {
      const row = await insertSuggestion(tx, {
        organizationId,
        targetType: NUDGE_TARGET_TYPE,
        payload: { idleMinutes: input.idleMinutes ?? null },
        rationale: input.rationale,
        sourceConversationId: input.conversationId,
        proposedBy: null,
      });
      await emitDomainEvent(tx, {
        type: "agent_suggestion.created",
        organizationId,
        suggestionId: row.id,
        conversationId: input.conversationId,
        targetType: NUDGE_TARGET_TYPE,
      });
      return row;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await pendingThreadCard(db, organizationId, input.conversationId);
    if (!existing) throw error;
    return existing;
  }
}

/** Requires messaging:write — the action layer reads the nudge's conversation. */
export async function findNudgeById(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const row = await withTenant(db, ctx.organizationId, (tx) =>
    findSuggestionById(tx, ctx.organizationId, suggestionId),
  );
  if (row?.targetType !== NUDGE_TARGET_TYPE) {
    throw new NotFoundError("Nudge", suggestionId);
  }
  return row;
}

/**
 * Requires messaging:write. "approved" is the nudge's "Gerar sugestão"
 * action — the server action enqueues generate-draft BEFORE calling this
 * so a skipped enqueue leaves the nudge pending; "rejected" dismisses.
 */
export async function reviewNudge(
  db: Database,
  ctx: TenantContext,
  input: ReviewNudgeInput,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { suggestionId, action } = reviewNudgeInput.parse(input);
  const reviewed = await withTenant(db, ctx.organizationId, async (tx) => {
    const suggestion = await findSuggestionById(tx, ctx.organizationId, suggestionId);
    if (suggestion?.targetType !== NUDGE_TARGET_TYPE) {
      throw new NotFoundError("Nudge", suggestionId);
    }
    if (suggestion.status !== "pending") {
      if (suggestion.status === action) return suggestion;
      throw new DomainError("NUDGE_ALREADY_REVIEWED", suggestion.status);
    }
    const row = await markSuggestionReviewed(tx, suggestionId, {
      status: action,
      reviewedBy: ctx.userId,
    });
    if (!row) throw new NotFoundError("Nudge", suggestionId);
    await emitDomainEvent(tx, {
      type: "agent_suggestion.reviewed",
      organizationId: ctx.organizationId,
      suggestionId,
      conversationId: suggestion.sourceConversationId ?? undefined,
      targetType: NUDGE_TARGET_TYPE,
    });
    return row;
  });
  audit(db, ctx, { action: `agent_nudge.${action}`, id: suggestionId });
  return reviewed;
}

type ApprovalDraft = { approved: AgentSuggestionRow } | { body: string; conversationId: string };

/** Reads the draft and refuses anything that is not sendable; an already-approved one short-circuits. */
async function readDraftForApproval(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<ApprovalDraft> {
  const suggestion = assertDraftRow(
    await withTenant(db, ctx.organizationId, (tx) =>
      findSuggestionById(tx, ctx.organizationId, suggestionId),
    ),
  );
  if (suggestion.status === "approved") return { approved: suggestion };
  if (suggestion.status !== "pending") {
    throw new DomainError("DRAFT_ALREADY_REVIEWED", suggestion.status);
  }
  const { body } = draftPayloadSchema.parse(suggestion.payload);
  const conversationId = suggestion.sourceConversationId;
  if (!conversationId) {
    throw new DomainError("DRAFT_NO_CONVERSATION", "draft has no source conversation");
  }
  return { body, conversationId };
}

/** Sends the claimed draft; a failed send releases the claim so the draft stays pending. */
async function sendClaimedDraft(
  db: Database,
  ctx: TenantContext,
  {
    suggestionId,
    conversationId,
    body,
    deps,
  }: {
    suggestionId: string;
    conversationId: string;
    body: string;
    deps?: { provider?: ChannelProvider };
  },
): Promise<void> {
  try {
    // Sends outside the review tx — provider latency must not hold row
    // locks. `automated` → anti-ban envelope (the body is AI-generated).
    await sendOutboundMessage(db, ctx, {
      input: { conversationId, text: body },
      deps: { ...deps, automated: true },
    });
  } catch (error) {
    // Release the claim so a failed send leaves the draft pending.
    await withTenant(db, ctx.organizationId, (tx) => releaseDraftClaim(tx, suggestionId)).catch(
      (releaseError: unknown) =>
        captureException(releaseError, { module: "drafts", action: "releaseDraftClaim" }),
    );
    throw error;
  }
}

/**
 * Requires messaging:write. Approve = send: the draft body goes out through
 * the normal outbound path (provider call, ticket → waiting_customer), then
 * the suggestion is marked reviewed. Send failure leaves it pending.
 */
export async function approveDraft(
  db: Database,
  ctx: TenantContext,
  { suggestionId, deps }: { suggestionId: string; deps?: { provider?: ChannelProvider } },
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const draft = await readDraftForApproval(db, ctx, suggestionId);
  if ("approved" in draft) return draft.approved;
  // Atomic claim — a concurrent approve that lands after this update gets
  // zero rows back, so the same draft can never be sent twice.
  const claimed = await withTenant(db, ctx.organizationId, (tx) =>
    claimPendingDraft(tx, suggestionId, ctx.userId),
  );
  // Another approve may have won the race between our status check and
  // the claim — return its outcome instead of sending again.
  if (!claimed) return reviewedDraftState(db, ctx, suggestionId);
  await sendClaimedDraft(db, ctx, { suggestionId, ...draft, deps });
  await withTenant(db, ctx.organizationId, (tx) =>
    emitDomainEvent(tx, {
      type: "agent_suggestion.reviewed",
      organizationId: ctx.organizationId,
      suggestionId,
      conversationId: draft.conversationId,
      targetType: DRAFT_TARGET_TYPE,
    }),
  );
  audit(db, ctx, { action: "agent_draft.approved", id: suggestionId });
  return claimed;
}

/** Requires messaging:write. Reject just dismisses the card. */
export async function rejectDraft(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const reviewed = await withTenant(db, ctx.organizationId, async (tx) => {
    const suggestion = assertDraftRow(
      await findSuggestionById(tx, ctx.organizationId, suggestionId),
    );
    if (suggestion.status === "rejected") return suggestion;
    if (suggestion.status !== "pending") {
      throw new DomainError("DRAFT_ALREADY_REVIEWED", suggestion.status);
    }
    const row = await markSuggestionReviewed(tx, suggestionId, {
      status: "rejected",
      reviewedBy: ctx.userId,
    });
    if (!row) throw new NotFoundError("Draft", suggestionId);
    await emitDomainEvent(tx, {
      type: "agent_suggestion.reviewed",
      organizationId: ctx.organizationId,
      suggestionId,
      conversationId: suggestion.sourceConversationId ?? undefined,
      targetType: DRAFT_TARGET_TYPE,
    });
    return row;
  });
  audit(db, ctx, { action: "agent_draft.rejected", id: suggestionId });
  return reviewed;
}

export { findOrCreateDrafter, findOrCreateObserver } from "./system-agents";

/** Validates a composer-side draft request (enqueue boundary). */
export function parseDraftRequest(input: unknown): z.output<typeof requestDraftInput> {
  return requestDraftInput.parse(input);
}

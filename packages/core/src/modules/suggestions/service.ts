import type { Database, DbExecutor } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { AuthorizationError, DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { recordAuditEvent } from "../audit";
import { proposeEntryInput } from "../brain";
import { proposeKnowledgeEntryInput } from "../knowledge";
import { proposeMacroInput } from "../macros";
import { applyPayload } from "./apply";
import type { AgentSuggestionRow } from "./repository";
import {
  findSuggestionById,
  insertSuggestion,
  listPendingByTargetType,
  listPendingForConversation,
  listSuggestions as repoListSuggestions,
  markSuggestionReviewed,
  scopeRefsExist,
} from "./repository";
import type { CreateSuggestionInput, ListSuggestionsInput } from "./schemas";
import { createSuggestionInput, listSuggestionsInput, suggestionTargetSchema } from "./schemas";

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
    metadata: { suggestionId },
  }).catch((error: unknown) => captureException(error, { module: "suggestions", action }));
}

/**
 * Requires ai:read. The settings inbox lists only configuration-class
 * targets — conversation-scoped kinds (drafts, nudges) live in the
 * thread UI and never surface here.
 */
export async function listAgentSuggestions(
  db: Database,
  ctx: TenantContext,
  input?: ListSuggestionsInput,
): Promise<AgentSuggestionRow[]> {
  assertPermission(ctx, { ai: ["read"] });
  const parsed = listSuggestionsInput.parse(input ?? {});
  return withTenant(db, ctx.organizationId, (tx) =>
    repoListSuggestions(tx, ctx.organizationId, {
      ...parsed,
      targetTypes: suggestionTargetSchema.options,
    }),
  );
}

/**
 * System path — called by the observer job, which authenticates itself
 * (tenant identity rebuilt from the DB) rather than a user. Tenant-scoped
 * write + SSE notification commit atomically.
 */
export async function createSystemSuggestion(
  db: Database,
  organizationId: string,
  input: CreateSuggestionInput,
): Promise<AgentSuggestionRow> {
  const parsed = createSuggestionInput.parse(input);
  return withTenant(db, organizationId, async (tx) => {
    const row = await insertSuggestion(tx, { organizationId, ...parsed });
    await emitDomainEvent(tx, {
      type: "agent_suggestion.created",
      organizationId,
      suggestionId: row.id,
    });
    return row;
  });
}

/**
 * Human-proposed memory staging — owner/admin only (spec §7.4), plus
 * ai:manage; `proposed_by` records who asked so the four-eyes rule can
 * block self-approval later (owner excepted — sovereign in single-person
 * orgs).
 */
export async function proposeMemoryEntry(
  db: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { ai: ["manage"] });
  if (!ctx.isPlatformAdmin && ctx.role !== "owner" && ctx.role !== "admin") {
    throw new AuthorizationError();
  }
  const { rationale, ...proposal } = proposeEntryInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    if (!(await scopeRefsExist(tx, ctx.organizationId, proposal))) {
      throw new DomainError("MEMORY_SCOPE_REF_INVALID", "teamId/contactId not found in org");
    }
    const row = await insertSuggestion(tx, {
      organizationId: ctx.organizationId,
      targetType: "memory",
      payload: proposal,
      rationale,
      proposedBy: ctx.userId,
    });
    await emitDomainEvent(tx, {
      type: "agent_suggestion.created",
      organizationId: ctx.organizationId,
      suggestionId: row.id,
    });
    return row;
  });
}

/**
 * Human-proposed knowledge staging ("Ensinar a IA") — any member with
 * messaging:write can teach the AI; proposals wait in Revisões for an
 * ai:manage reviewer (spec §7.4). The source conversation is stored so the
 * review card can link back to where the excerpt came from.
 */
export async function proposeKnowledgeEntry(
  db: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { rationale, sourceConversationId, ...proposal } = proposeKnowledgeEntryInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const row = await insertSuggestion(tx, {
      organizationId: ctx.organizationId,
      targetType: "knowledge_entry",
      payload: proposal,
      rationale,
      proposedBy: ctx.userId,
      sourceConversationId,
    });
    await emitDomainEvent(tx, {
      type: "agent_suggestion.created",
      organizationId: ctx.organizationId,
      suggestionId: row.id,
    });
    return row;
  });
}

/**
 * Agent-proposed macro staging — any member with messaging:write can
 * propose a quick reply; managers+ approve in settings/service/macros.
 * `proposedBy` records who asked so the four-eyes rule blocks
 * self-approval (owner excepted).
 */
export async function proposeMacroEntry(
  db: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { messaging: ["write"] });
  const { rationale, ...proposal } = proposeMacroInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const row = await insertSuggestion(tx, {
      organizationId: ctx.organizationId,
      targetType: "macro",
      payload: proposal,
      rationale,
      proposedBy: ctx.userId,
    });
    await emitDomainEvent(tx, {
      type: "agent_suggestion.created",
      organizationId: ctx.organizationId,
      suggestionId: row.id,
    });
    return row;
  });
}

/** Pending macro proposals — the settings/service/macros review section. */
export async function listPendingMacroSuggestions(
  db: Database,
  ctx: TenantContext,
): Promise<AgentSuggestionRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) =>
    listPendingByTargetType(tx, ctx.organizationId, "macro"),
  );
}

/** Pending memory proposal contents — observer dedupe context (normalized). */
export async function listPendingMemoryContents(
  db: Database,
  organizationId: string,
): Promise<string[]> {
  return withTenant(db, organizationId, async (tx) =>
    (await listPendingByTargetType(tx, organizationId, "memory")).map((row) =>
      normalizeContent((row.payload as { content?: string }).content ?? ""),
    ),
  );
}

function normalizeContent(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Dedupe key — memory proposals match on normalized content; config on target identity. */
function suggestionKey(targetType: string, targetId: string | null, payload: unknown): string {
  if (targetType === "memory") {
    return `memory:${normalizeContent((payload as { content?: string }).content ?? "")}`;
  }
  return `${targetType}:${targetId ?? ""}`;
}

/**
 * Observer batch insert — one transaction, one SSE event per row.
 * Idempotent: an input whose dedupe key already has a pending suggestion
 * from the same source conversation is skipped, so job retries and
 * repeated analyze triggers can't pile up duplicates.
 */
export async function createSystemSuggestions(
  db: Database,
  organizationId: string,
  inputs: CreateSuggestionInput[],
): Promise<AgentSuggestionRow[]> {
  if (inputs.length === 0) return [];
  const parsed = inputs.map((input) => createSuggestionInput.parse(input));
  return withTenant(db, organizationId, async (tx) => {
    const conversationIds = [
      ...new Set(
        parsed
          .map((p) => p.sourceConversationId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const existing = new Set(
      (
        await Promise.all(
          conversationIds.map((id) => listPendingForConversation(tx, organizationId, id)),
        )
      )
        .flat()
        .map((row) => suggestionKey(row.targetType, row.targetId ?? null, row.payload)),
    );
    const created: AgentSuggestionRow[] = [];
    for (const input of parsed) {
      if (
        input.sourceConversationId &&
        existing.has(suggestionKey(input.targetType, input.targetId ?? null, input.payload))
      ) {
        continue;
      }
      const row = await insertSuggestion(tx, { organizationId, ...input });
      created.push(row);
      await emitDomainEvent(tx, {
        type: "agent_suggestion.created",
        organizationId,
        suggestionId: row.id,
      });
    }
    return created;
  });
}

/**
 * Conversation-scoped targets (drafts…) have their own review services —
 * the generic review path only handles configuration-class suggestions.
 */
function assertConfigSuggestion(ctx: TenantContext, suggestion: AgentSuggestionRow): void {
  if (!(suggestionTargetSchema.options as readonly string[]).includes(suggestion.targetType)) {
    throw new DomainError("SUGGESTION_TARGET_UNSUPPORTED", suggestion.targetType);
  }
  // Memory decisions are owner/admin only (spec §7.4) even though managers
  // hold ai:manage for the rest of the review queue.
  if (
    suggestion.targetType === "memory" &&
    ctx.role !== "owner" &&
    ctx.role !== "admin" &&
    !ctx.isPlatformAdmin
  ) {
    throw new AuthorizationError();
  }
}

async function loadForReview(
  tx: DbExecutor,
  ctx: TenantContext,
  suggestionId: string,
): Promise<AgentSuggestionRow> {
  const suggestion = await findSuggestionById(tx, ctx.organizationId, suggestionId);
  if (!suggestion) throw new NotFoundError("AgentSuggestion", suggestionId);
  assertConfigSuggestion(ctx, suggestion);
  return suggestion;
}

function assertPending(suggestion: AgentSuggestionRow): void {
  if (suggestion.status !== "pending") {
    throw new DomainError("SUGGESTION_ALREADY_REVIEWED", suggestion.status);
  }
}

async function finishReview(
  tx: DbExecutor,
  ctx: TenantContext,
  { suggestionId, status }: { suggestionId: string; status: "approved" | "rejected" },
): Promise<AgentSuggestionRow> {
  const row = await markSuggestionReviewed(tx, suggestionId, {
    status,
    reviewedBy: ctx.userId,
  });
  if (!row) throw new NotFoundError("AgentSuggestion", suggestionId);
  await emitDomainEvent(tx, {
    type: "agent_suggestion.reviewed",
    organizationId: ctx.organizationId,
    suggestionId,
  });
  return row;
}

/** Requires ai:manage. Idempotent: re-approving returns the row unchanged. */
export async function approveSuggestion(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const reviewed = await withTenant(db, ctx.organizationId, async (tx) => {
    const suggestion = await loadForReview(tx, ctx, suggestionId);
    if (suggestion.status === "approved") return suggestion;
    assertPending(suggestion);
    // Four-eyes: the proposer can't approve their own suggestion — except
    // the owner, who is sovereign (single-person orgs have no reviewer #2).
    if (suggestion.proposedBy === ctx.userId && ctx.role !== "owner" && !ctx.isPlatformAdmin) {
      throw new DomainError("SUGGESTION_SELF_APPROVE", "proposer cannot self-approve");
    }
    await applyPayload(tx, suggestion, ctx.userId);
    return finishReview(tx, ctx, { suggestionId, status: "approved" });
  });
  audit(db, ctx, { action: "agent_suggestion.approved", id: suggestionId });
  return reviewed;
}

/** Requires ai:manage. Idempotent: re-rejecting returns the row unchanged. */
export async function rejectSuggestion(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<AgentSuggestionRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const reviewed = await withTenant(db, ctx.organizationId, async (tx) => {
    const suggestion = await loadForReview(tx, ctx, suggestionId);
    if (suggestion.status === "rejected") return suggestion;
    assertPending(suggestion);
    return finishReview(tx, ctx, { suggestionId, status: "rejected" });
  });
  audit(db, ctx, { action: "agent_suggestion.rejected", id: suggestionId });
  return reviewed;
}

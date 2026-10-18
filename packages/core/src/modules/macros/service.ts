import type { Database, DbExecutor } from "@crm/db";
import { emitDomainEvent, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { AuthorizationError, DomainError, NotFoundError } from "../../errors";
import { isUniqueViolation } from "../../lib/pg-error";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { recordAuditEvent } from "../audit";
import { findSuggestionById, markSuggestionReviewed } from "../suggestions";
import type { MacroRow } from "./repository";
import {
  deleteMacroRow,
  findMacroById,
  insertMacro,
  listMacros,
  searchMacros,
  updateMacroRow,
} from "./repository";
import type { CreateMacroInput, UpdateMacroInput } from "./schemas";
import { createMacroInput, updateMacroInput } from "./schemas";

/** Direct write = manager/admin/owner (agents only propose via suggestions). */
function assertMacroWriter(ctx: TenantContext): void {
  assertPermission(ctx, { messaging: ["write"] });
  if (
    !ctx.isPlatformAdmin &&
    ctx.role !== "owner" &&
    ctx.role !== "admin" &&
    ctx.role !== "manager"
  ) {
    throw new AuthorizationError();
  }
}

/** Requires messaging:read — every member can consume macros in the composer. */
export async function listOrgMacros(db: Database, ctx: TenantContext): Promise<MacroRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) => listMacros(tx, ctx.organizationId));
}

/** Requires messaging:read — prefix search for the `/` composer picker. */
export async function searchOrgMacros(
  db: Database,
  ctx: TenantContext,
  prefix: string,
): Promise<MacroRow[]> {
  assertPermission(ctx, { messaging: ["read"] });
  const safePrefix = prefix.trim().slice(0, 60);
  return withTenant(db, ctx.organizationId, (tx) =>
    safePrefix
      ? searchMacros(tx, ctx.organizationId, { prefix: safePrefix })
      : listMacros(tx, ctx.organizationId),
  );
}

/** Requires messaging:write + manager/admin/owner. */
export async function createMacro(
  db: Database,
  ctx: TenantContext,
  input: CreateMacroInput,
): Promise<MacroRow> {
  assertMacroWriter(ctx);
  const parsed = createMacroInput.parse(input);
  try {
    return await withTenant(db, ctx.organizationId, (tx) =>
      insertMacro(tx, { organizationId: ctx.organizationId, ...parsed, createdBy: ctx.userId }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError("MACRO_NAME_TAKEN", `macro "${parsed.name}" already exists`);
    }
    throw error;
  }
}

/** Requires messaging:write + manager/admin/owner. */
export async function updateMacro(
  db: Database,
  ctx: TenantContext,
  { macroId, input }: { macroId: string; input: UpdateMacroInput },
): Promise<MacroRow> {
  assertMacroWriter(ctx);
  const parsed = updateMacroInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const existing = await findMacroById(tx, ctx.organizationId, macroId);
    if (!existing) throw new NotFoundError("Macro", macroId);
    try {
      const row = await updateMacroRow(tx, existing.id, parsed);
      if (!row) throw new NotFoundError("Macro", macroId);
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError("MACRO_NAME_TAKEN", `macro name already in use`);
      }
      throw error;
    }
  });
}

/** Requires messaging:write + manager/admin/owner. */
export async function deleteMacro(
  db: Database,
  ctx: TenantContext,
  macroId: string,
): Promise<void> {
  assertMacroWriter(ctx);
  await withTenant(db, ctx.organizationId, async (tx) => {
    const existing = await findMacroById(tx, ctx.organizationId, macroId);
    if (!existing) throw new NotFoundError("Macro", macroId);
    await deleteMacroRow(tx, existing.id);
  });
}

// --- Suggestion review (agent proposal → manager/admin/owner decision) -------

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
  }).catch((error: unknown) => captureException(error, { module: "macros", action }));
}

/**
 * Applies the approved proposal inside the caller's tenant tx. `targetId`
 * set means an edit proposal; null creates a new macro. Same
 * conflict-translation posture as the generic suggestions apply path.
 */
async function applyMacroProposal(
  executor: DbExecutor,
  suggestion: {
    organizationId: string;
    targetId: string | null;
    payload: unknown;
    proposedBy: string | null;
  },
  reviewerId: string,
): Promise<void> {
  try {
    if (suggestion.targetId) {
      const existing = await findMacroById(
        executor,
        suggestion.organizationId,
        suggestion.targetId,
      );
      if (!existing) throw new NotFoundError("Macro", suggestion.targetId);
      await updateMacroRow(
        executor,
        existing.id,
        createMacroInput.partial().parse(suggestion.payload),
      );
    } else {
      await insertMacro(executor, {
        organizationId: suggestion.organizationId,
        ...createMacroInput.parse(suggestion.payload),
        createdBy: suggestion.proposedBy ?? reviewerId,
      });
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError(
        "SUGGESTION_APPLY_CONFLICT",
        "Suggestion payload conflicts with an existing record",
      );
    }
    throw error;
  }
}

/**
 * Requires ai:manage (owner/admin/manager). Approves a pending macro
 * proposal and materializes the macro in the same transaction.
 * Four-eyes: the proposer can't approve their own — except the owner
 * (sovereign in single-person orgs).
 */
export async function approveMacroSuggestion(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<void> {
  assertPermission(ctx, { ai: ["manage"] });
  await withTenant(db, ctx.organizationId, async (tx) => {
    const suggestion = await findSuggestionById(tx, ctx.organizationId, suggestionId);
    if (suggestion?.targetType !== "macro") {
      throw new NotFoundError("AgentSuggestion", suggestionId);
    }
    if (suggestion.status === "approved") return;
    if (suggestion.status !== "pending") {
      throw new DomainError("SUGGESTION_ALREADY_REVIEWED", suggestion.status);
    }
    if (suggestion.proposedBy === ctx.userId && ctx.role !== "owner" && !ctx.isPlatformAdmin) {
      throw new DomainError("SUGGESTION_SELF_APPROVE", "proposer cannot self-approve");
    }
    await applyMacroProposal(tx, suggestion, ctx.userId);
    await markSuggestionReviewed(tx, suggestionId, {
      status: "approved",
      reviewedBy: ctx.userId,
    });
    await emitDomainEvent(tx, {
      type: "agent_suggestion.reviewed",
      organizationId: ctx.organizationId,
      suggestionId,
    });
  });
  audit(db, ctx, { action: "agent_suggestion.approved", id: suggestionId });
}

/** Requires ai:manage. Idempotent: re-rejecting is a no-op. */
export async function rejectMacroSuggestion(
  db: Database,
  ctx: TenantContext,
  suggestionId: string,
): Promise<void> {
  assertPermission(ctx, { ai: ["manage"] });
  await withTenant(db, ctx.organizationId, async (tx) => {
    const suggestion = await findSuggestionById(tx, ctx.organizationId, suggestionId);
    if (suggestion?.targetType !== "macro") {
      throw new NotFoundError("AgentSuggestion", suggestionId);
    }
    if (suggestion.status === "rejected") return;
    if (suggestion.status !== "pending") {
      throw new DomainError("SUGGESTION_ALREADY_REVIEWED", suggestion.status);
    }
    await markSuggestionReviewed(tx, suggestionId, {
      status: "rejected",
      reviewedBy: ctx.userId,
    });
    await emitDomainEvent(tx, {
      type: "agent_suggestion.reviewed",
      organizationId: ctx.organizationId,
      suggestionId,
    });
  });
  audit(db, ctx, { action: "agent_suggestion.rejected", id: suggestionId });
}

import type { DbExecutor } from "@crm/db";

import { DomainError, NotFoundError } from "../../errors";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-error";
import { createAgentInput, findAgentById, insertAgent, updateAgentRow } from "../agents";
import {
  findMemoryEntryById,
  insertMemoryEntry,
  memoryProposalSchema,
  updateMemoryEntry,
} from "../brain";
import { createKnowledgeEntryInput, findEntryById, insertEntry, updateEntry } from "../knowledge";
import type { AgentSuggestionRow } from "./repository";
import { scopeRefsExist } from "./repository";

async function applyAgentPayload(
  executor: DbExecutor,
  organizationId: string,
  { targetId, payload }: { targetId: string | null; payload: unknown },
): Promise<void> {
  if (targetId) {
    const existing = await findAgentById(executor, organizationId, targetId);
    if (!existing) throw new NotFoundError("Agent", targetId);
    await updateAgentRow(executor, existing.id, createAgentInput.partial().parse(payload));
  } else {
    await insertAgent(executor, { organizationId, ...createAgentInput.parse(payload) });
  }
}

async function applyKnowledgePayload(
  executor: DbExecutor,
  organizationId: string,
  { targetId, payload }: { targetId: string | null; payload: unknown },
): Promise<void> {
  if (targetId) {
    const existing = await findEntryById(executor, organizationId, targetId);
    if (!existing) throw new NotFoundError("KnowledgeEntry", targetId);
    await updateEntry(executor, existing.id, createKnowledgeEntryInput.partial().parse(payload));
  } else {
    await insertEntry(executor, {
      organizationId,
      ...createKnowledgeEntryInput.parse(payload),
      source: "suggestion",
    });
  }
}

/** The canon entry a proposal retires, or null; it must exist and still be canon. */
async function findSupersededId(
  executor: DbExecutor,
  { organizationId, supersedes }: { organizationId: string; supersedes: string | null | undefined },
): Promise<string | null> {
  if (!supersedes) return null;
  const old = await findMemoryEntryById(executor, organizationId, supersedes);
  if (!old) throw new NotFoundError("MemoryEntry", supersedes);
  if (old.status !== "canon") {
    throw new DomainError("MEMORY_ALREADY_SUPERSEDED", old.status);
  }
  return old.id;
}

/**
 * Memory apply — payload describes the canon entry to promote. A
 * `supersedes` link retires the previous entry in the same transaction
 * (temporal chain instead of destructive update).
 */
async function applyMemoryPayload(
  executor: DbExecutor,
  suggestion: AgentSuggestionRow,
  reviewerId: string,
): Promise<void> {
  const proposal = memoryProposalSchema.parse(suggestion.payload);
  const supersedesId = await findSupersededId(executor, {
    organizationId: suggestion.organizationId,
    supersedes: proposal.supersedes,
  });
  if (!(await scopeRefsExist(executor, suggestion.organizationId, proposal))) {
    throw new DomainError("MEMORY_SCOPE_REF_INVALID", "teamId/contactId not found in org");
  }
  const entry = await insertMemoryEntry(executor, {
    organizationId: suggestion.organizationId,
    type: proposal.type,
    scope: proposal.scope,
    teamId: proposal.teamId ?? null,
    contactId: proposal.contactId ?? null,
    content: proposal.content,
    confidence: proposal.confidence,
    staleAfter: new Date(Date.now() + proposal.staleAfterDays * 86_400_000),
    sources: {
      conversations: proposal.sourceConversationIds,
      suggestion: suggestion.id,
      proposedBy: suggestion.proposedBy,
    },
    verifiedBy: reviewerId,
  });
  if (supersedesId) {
    await updateMemoryEntry(executor, supersedesId, {
      status: "superseded",
      supersededBy: entry.id,
    });
  }
}

/**
 * Applies the payload diff to the target entity inside the caller's
 * tenant-scoped transaction. `targetId` null means the suggestion creates
 * a new entity (payload must satisfy the full create schema).
 */
export async function applyPayload(
  executor: DbExecutor,
  suggestion: AgentSuggestionRow,
  reviewerId: string,
): Promise<void> {
  const targetId = suggestion.targetId ?? null;
  try {
    if (suggestion.targetType === "agent") {
      await applyAgentPayload(executor, suggestion.organizationId, {
        targetId,
        payload: suggestion.payload,
      });
    } else if (suggestion.targetType === "knowledge_entry") {
      await applyKnowledgePayload(executor, suggestion.organizationId, {
        targetId,
        payload: suggestion.payload,
      });
    } else if (suggestion.targetType === "memory") {
      await applyMemoryPayload(executor, suggestion, reviewerId);
    } else {
      throw new DomainError("SUGGESTION_TARGET_UNSUPPORTED", suggestion.targetType);
    }
  } catch (error) {
    if (isUniqueViolation(error) || isForeignKeyViolation(error)) {
      throw new DomainError(
        "SUGGESTION_APPLY_CONFLICT",
        "Suggestion payload conflicts with an existing record",
      );
    }
    throw error;
  }
}

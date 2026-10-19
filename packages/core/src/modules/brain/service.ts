import type { Database } from "@crm/db";
import { withServiceAccess, withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { DomainError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { recordAuditEvent } from "../audit";
import type { MemoryEntryRow } from "./repository";
import {
  findMemoryEntryById,
  listCanonEntries,
  listStaleEntries,
  markAllExpiredStale,
  updateMemoryEntry,
} from "./repository";
import type { ListBrainEntriesInput, RenewEntryInput } from "./schemas";
import { listBrainEntriesInput, renewEntryInput } from "./schemas";

/** Audit is post-commit best-effort — a logging failure must not fail the mutation. */
function audit(
  db: Database,
  ctx: TenantContext,
  { action, id: entryId }: { action: string; id: string },
): void {
  recordAuditEvent(db, ctx, {
    action,
    targetType: "memory_entry",
    targetId: entryId,
    metadata: { entryId },
  }).catch((error: unknown) => captureException(error, { module: "brain", action }));
}

/** Requires ai:read — canon entries, optionally narrowed by scope/type/FTS. */
export async function listBrainEntries(
  db: Database,
  ctx: TenantContext,
  input?: ListBrainEntriesInput,
): Promise<MemoryEntryRow[]> {
  assertPermission(ctx, { ai: ["read"] });
  const parsed = listBrainEntriesInput.parse(input ?? {});
  return withTenant(db, ctx.organizationId, (tx) =>
    listCanonEntries(tx, ctx.organizationId, parsed),
  );
}

/** Requires ai:read — canon entries past `stale_after`, awaiting human review. */
export async function listStaleBrainEntries(
  db: Database,
  ctx: TenantContext,
): Promise<MemoryEntryRow[]> {
  assertPermission(ctx, { ai: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) => listStaleEntries(tx, ctx.organizationId));
}

/**
 * Canon entries relevant to a conversation context — org-wide plus the
 * conversation's team/contact scoped rows. System path (observer job):
 * no user ctx, tenant scope rebuilt from the DB row.
 */
export async function listCanonForContext(
  db: Database,
  organizationId: string,
  context: { teamId?: string; contactId?: string; q?: string; limit?: number },
): Promise<MemoryEntryRow[]> {
  return withTenant(db, organizationId, (tx) =>
    listCanonEntries(tx, organizationId, {
      teamId: context.teamId,
      contactId: context.contactId,
      q: context.q,
      limit: context.limit ?? 10,
    }),
  );
}

/** Requires ai:manage — confirm a stale entry is still valid (extends `stale_after`). */
export async function renewBrainEntry(
  db: Database,
  ctx: TenantContext,
  input: RenewEntryInput,
): Promise<MemoryEntryRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const parsed = renewEntryInput.parse(input);
  const updated = await withTenant(db, ctx.organizationId, async (tx) => {
    const entry = await findMemoryEntryById(tx, ctx.organizationId, parsed.entryId);
    if (!entry) throw new NotFoundError("MemoryEntry", parsed.entryId);
    if (entry.status !== "stale" && entry.status !== "canon") {
      throw new DomainError("MEMORY_ENTRY_NOT_RENEWABLE", entry.status);
    }
    const row = await updateMemoryEntry(tx, entry.id, {
      status: "canon",
      staleAfter: new Date(Date.now() + parsed.staleAfterDays * 86_400_000),
    });
    if (!row) throw new NotFoundError("MemoryEntry", parsed.entryId);
    return row;
  });
  audit(db, ctx, { action: "memory_entry.renewed", id: updated.id });
  return updated;
}

/** Requires ai:manage — remove an entry from the canon (stale queue or direct). */
export async function archiveBrainEntry(
  db: Database,
  ctx: TenantContext,
  entryId: string,
): Promise<MemoryEntryRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const updated = await withTenant(db, ctx.organizationId, async (tx) => {
    const entry = await findMemoryEntryById(tx, ctx.organizationId, entryId);
    if (!entry) throw new NotFoundError("MemoryEntry", entryId);
    if (entry.status === "archived" || entry.status === "superseded") {
      throw new DomainError("MEMORY_ENTRY_NOT_ARCHIVABLE", entry.status);
    }
    const row = await updateMemoryEntry(tx, entry.id, { status: "archived" });
    if (!row) throw new NotFoundError("MemoryEntry", entryId);
    return row;
  });
  audit(db, ctx, { action: "memory_entry.archived", id: updated.id });
  return updated;
}

/** Daily sweep — canon rows past `stale_after` become `stale` (human renews or archives). */
export async function sweepStaleBrainEntries(db: Database): Promise<number> {
  return withServiceAccess(db, (tx) => markAllExpiredStale(tx, new Date()));
}

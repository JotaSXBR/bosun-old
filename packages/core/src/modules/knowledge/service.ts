import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { recordAuditEvent } from "../audit";
import type { KnowledgeEntryRow } from "./repository";
import {
  deleteEntry,
  findEntryById,
  insertEntry,
  listEntries as repoListEntries,
  updateEntry as repoUpdateEntry,
} from "./repository";
import type { CreateKnowledgeEntryInput, UpdateKnowledgeEntryInput } from "./schemas";
import { createKnowledgeEntryInput, updateKnowledgeEntryInput } from "./schemas";

/** Audit is post-commit best-effort — a logging failure must not fail the mutation. */
function audit(
  db: Database,
  ctx: TenantContext,
  { action, id: entryId }: { action: string; id: string },
): void {
  recordAuditEvent(db, ctx, {
    action,
    targetType: "knowledge_entry",
    targetId: entryId,
    metadata: { entryId },
  }).catch((error: unknown) => captureException(error, { module: "knowledge", action }));
}

/** Requires ai:read. */
export async function listKnowledgeEntries(
  db: Database,
  ctx: TenantContext,
): Promise<KnowledgeEntryRow[]> {
  assertPermission(ctx, { ai: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) => repoListEntries(tx, ctx.organizationId));
}

/** Requires ai:manage. */
export async function createKnowledgeEntry(
  db: Database,
  ctx: TenantContext,
  input: CreateKnowledgeEntryInput,
): Promise<KnowledgeEntryRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const parsed = createKnowledgeEntryInput.parse(input);
  const entry = await withTenant(db, ctx.organizationId, (tx) =>
    insertEntry(tx, {
      organizationId: ctx.organizationId,
      title: parsed.title,
      content: parsed.content,
      status: parsed.status,
      source: "manual",
    }),
  );
  audit(db, ctx, { action: "knowledge_entry.created", id: entry.id });
  return entry;
}

/** Requires ai:manage. */
export async function updateKnowledgeEntry(
  db: Database,
  ctx: TenantContext,
  input: UpdateKnowledgeEntryInput,
): Promise<KnowledgeEntryRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const parsed = updateKnowledgeEntryInput.parse(input);
  return withTenant(db, ctx.organizationId, async (tx) => {
    const existing = await findEntryById(tx, ctx.organizationId, parsed.entryId);
    if (!existing) throw new NotFoundError("KnowledgeEntry", parsed.entryId);
    const { entryId: _, ...fields } = parsed;
    const updated = await repoUpdateEntry(tx, existing.id, fields);
    if (!updated) throw new NotFoundError("KnowledgeEntry", parsed.entryId);
    return updated;
  });
}

/** Requires ai:manage. */
export async function deleteKnowledgeEntry(
  db: Database,
  ctx: TenantContext,
  entryId: string,
): Promise<void> {
  assertPermission(ctx, { ai: ["manage"] });
  await withTenant(db, ctx.organizationId, async (tx) => {
    const existing = await findEntryById(tx, ctx.organizationId, entryId);
    if (!existing) throw new NotFoundError("KnowledgeEntry", entryId);
    await deleteEntry(tx, existing.id);
  });
  audit(db, ctx, { action: "knowledge_entry.deleted", id: entryId });
}

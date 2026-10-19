import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";

const { memoryEntries } = schema;

export type MemoryEntryRow = typeof memoryEntries.$inferSelect;

export async function insertMemoryEntry(
  executor: DbExecutor,
  values: {
    organizationId: string;
    type: string;
    scope: string;
    teamId?: string | null;
    contactId?: string | null;
    content: string;
    confidence: string;
    sources: unknown;
    staleAfter: Date;
    verifiedBy?: string | null;
  },
): Promise<MemoryEntryRow> {
  const [row] = await executor
    .insert(memoryEntries)
    .values({ ...values, verifiedAt: new Date() })
    .returning();
  if (!row) throw new Error("memory_entries insert returned no row");
  return row;
}

export async function findMemoryEntryById(
  executor: DbExecutor,
  organizationId: string,
  entryId: string,
): Promise<MemoryEntryRow | null> {
  const [row] = await executor
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.id, entryId), eq(memoryEntries.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function updateMemoryEntry(
  executor: DbExecutor,
  entryId: string,
  values: Partial<{
    status: string;
    supersededBy: string | null;
    staleAfter: Date;
    verifiedBy: string | null;
    verifiedAt: Date | null;
  }>,
): Promise<MemoryEntryRow | undefined> {
  const [row] = await executor
    .update(memoryEntries)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(memoryEntries.id, entryId))
    .returning();
  return row;
}

type CanonFilter = {
  type?: string;
  scope?: string;
  teamId?: string;
  contactId?: string;
  q?: string;
  limit: number;
};

function explicitScopeConditions(filter: CanonFilter, scope: string): SQL[] {
  const conditions: SQL[] = [eq(memoryEntries.scope, scope)];
  if (scope === "team" && filter.teamId) {
    conditions.push(eq(memoryEntries.teamId, filter.teamId));
  }
  if (scope === "contact" && filter.contactId) {
    conditions.push(eq(memoryEntries.contactId, filter.contactId));
  }
  return conditions;
}

/**
 * Scope narrowing — an explicit `scope` filters to that scope (optionally a
 * specific team/contact); otherwise a teamId/contactId context widens the
 * reader to org-wide entries plus rows scoped to that team/contact.
 */
function scopeConditions(filter: CanonFilter): SQL[] {
  if (filter.scope) return explicitScopeConditions(filter, filter.scope);
  if (!filter.teamId && !filter.contactId) return [];
  const scoped: SQL[] = [eq(memoryEntries.scope, "org")];
  if (filter.teamId) {
    scoped.push(and(eq(memoryEntries.scope, "team"), eq(memoryEntries.teamId, filter.teamId))!);
  }
  if (filter.contactId) {
    scoped.push(
      and(eq(memoryEntries.scope, "contact"), eq(memoryEntries.contactId, filter.contactId))!,
    );
  }
  return [or(...scoped)!];
}

/**
 * Canon rows for a reader — optionally narrowed by scope, type and a
 * Portuguese FTS query. Relevance for a conversation = org-wide entries,
 * plus that conversation's team/contact scoped rows.
 */
export async function listCanonEntries(
  executor: DbExecutor,
  organizationId: string,
  filter: CanonFilter,
): Promise<MemoryEntryRow[]> {
  const conditions: SQL[] = [
    eq(memoryEntries.organizationId, organizationId),
    eq(memoryEntries.status, "canon"),
    ...scopeConditions(filter),
  ];
  if (filter.type) conditions.push(eq(memoryEntries.type, filter.type));
  if (filter.q) {
    conditions.push(
      sql`to_tsvector('portuguese', ${memoryEntries.content}) @@ plainto_tsquery('portuguese', ${filter.q})`,
    );
  }
  return executor
    .select()
    .from(memoryEntries)
    .where(and(...conditions))
    .orderBy(desc(memoryEntries.createdAt))
    .limit(filter.limit);
}

export async function listStaleEntries(
  executor: DbExecutor,
  organizationId: string,
  limit = 100,
): Promise<MemoryEntryRow[]> {
  return executor
    .select()
    .from(memoryEntries)
    .where(and(eq(memoryEntries.organizationId, organizationId), eq(memoryEntries.status, "stale")))
    .orderBy(memoryEntries.staleAfter)
    .limit(limit);
}

/** Stale sweep — canon rows past their `stale_after` become `stale`. */
export async function markExpiredStale(
  executor: DbExecutor,
  organizationId: string,
  now: Date,
): Promise<MemoryEntryRow[]> {
  return executor
    .update(memoryEntries)
    .set({ status: "stale", updatedAt: now })
    .where(
      and(
        eq(memoryEntries.organizationId, organizationId),
        eq(memoryEntries.status, "canon"),
        lt(memoryEntries.staleAfter, now),
      ),
    )
    .returning();
}

/** All orgs' expired canon rows — platform-scope sweep path. */
export async function markAllExpiredStale(executor: DbExecutor, now: Date): Promise<number> {
  const rows = await executor
    .update(memoryEntries)
    .set({ status: "stale", updatedAt: now })
    .where(and(eq(memoryEntries.status, "canon"), lt(memoryEntries.staleAfter, now)))
    .returning({ id: memoryEntries.id });
  return rows.length;
}

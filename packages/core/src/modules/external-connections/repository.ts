import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, eq, isNotNull } from "drizzle-orm";

const { externalConnections } = schema;

export type ExternalConnectionRow = typeof externalConnections.$inferSelect;
/** Public shape — never carries `bundleEncrypted`. */
export type ExternalConnectionPublic = Omit<ExternalConnectionRow, "bundleEncrypted">;

export function toPublic(row: ExternalConnectionRow): ExternalConnectionPublic {
  const { bundleEncrypted: _bundle, ...rest } = row;
  return rest;
}

/** Internal — returns the encrypted bundle. Callers must stay inside `withTenant`. */
export async function findConnection(
  executor: DbExecutor,
  organizationId: string,
  provider: string,
): Promise<ExternalConnectionRow | null> {
  const [row] = await executor
    .select()
    .from(externalConnections)
    .where(
      and(
        eq(externalConnections.organizationId, organizationId),
        eq(externalConnections.provider, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertConnection(
  executor: DbExecutor,
  values: {
    organizationId: string;
    provider: string;
    status: string;
    bundleEncrypted: string;
  },
): Promise<void> {
  await executor
    .insert(externalConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [externalConnections.organizationId, externalConnections.provider],
      set: {
        status: values.status,
        bundleEncrypted: values.bundleEncrypted,
        accountEmail: null,
        lastCheckedAt: null,
        lastError: null,
        autoSyncSince: null,
        lastSweepAt: null,
        updatedAt: new Date(),
      },
    });
}

export async function updateConnection(
  executor: DbExecutor,
  id: string,
  values: Partial<
    Pick<
      ExternalConnectionRow,
      | "status"
      | "bundleEncrypted"
      | "accountEmail"
      | "lastCheckedAt"
      | "lastError"
      | "autoSyncSince"
      | "lastSweepAt"
    >
  >,
): Promise<ExternalConnectionRow | undefined> {
  const [row] = await executor
    .update(externalConnections)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(externalConnections.id, id))
    .returning();
  return row;
}

export async function deleteConnection(executor: DbExecutor, id: string): Promise<void> {
  await executor.delete(externalConnections).where(eq(externalConnections.id, id));
}

/** Cross-tenant — call inside withServiceAccess. Orgs with a live connection that consented to automatic sync. */
export async function listAutoSyncOrganizationIds(
  executor: DbExecutor,
  provider: string,
): Promise<string[]> {
  const rows = await executor
    .select({ organizationId: externalConnections.organizationId })
    .from(externalConnections)
    .where(
      and(
        eq(externalConnections.provider, provider),
        eq(externalConnections.status, "connected"),
        isNotNull(externalConnections.autoSyncSince),
      ),
    );
  return rows.map((row) => row.organizationId);
}

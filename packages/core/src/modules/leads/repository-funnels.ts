import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, asc, eq } from "drizzle-orm";

const { funnels } = schema;

export type FunnelRow = typeof funnels.$inferSelect;

export async function listFunnels(executor: DbExecutor, organizationId: string) {
  return executor
    .select()
    .from(funnels)
    .where(eq(funnels.organizationId, organizationId))
    .orderBy(asc(funnels.createdAt));
}

export async function findFunnelById(
  executor: DbExecutor,
  organizationId: string,
  funnelId: string,
) {
  const [row] = await executor
    .select()
    .from(funnels)
    .where(and(eq(funnels.id, funnelId), eq(funnels.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function insertFunnel(
  executor: DbExecutor,
  values: { organizationId: string; name: string; templateRef?: string | undefined },
) {
  const [row] = await executor.insert(funnels).values(values).returning();
  if (!row) throw new Error("funnels insert returned no row");
  return row;
}

export async function updateFunnel(
  executor: DbExecutor,
  funnelId: string,
  values: { name: string },
) {
  const [row] = await executor
    .update(funnels)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(funnels.id, funnelId))
    .returning();
  return row;
}

export async function deleteFunnel(executor: DbExecutor, funnelId: string) {
  const rows = await executor
    .delete(funnels)
    .where(eq(funnels.id, funnelId))
    .returning({ id: funnels.id });
  return rows.length > 0;
}

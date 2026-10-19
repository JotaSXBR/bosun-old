import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, asc, eq, ilike } from "drizzle-orm";

const { macros } = schema;

export type MacroRow = typeof macros.$inferSelect;

export async function listMacros(
  executor: DbExecutor,
  organizationId: string,
): Promise<MacroRow[]> {
  return executor
    .select()
    .from(macros)
    .where(eq(macros.organizationId, organizationId))
    .orderBy(asc(macros.name));
}

/** Prefix search for the composer `/` picker. */
export async function searchMacros(
  executor: DbExecutor,
  organizationId: string,
  { prefix, limit = 10 }: { prefix: string; limit?: number },
): Promise<MacroRow[]> {
  return executor
    .select()
    .from(macros)
    .where(and(eq(macros.organizationId, organizationId), ilike(macros.name, `${prefix}%`)))
    .orderBy(asc(macros.name))
    .limit(limit);
}

export async function findMacroById(
  executor: DbExecutor,
  organizationId: string,
  macroId: string,
): Promise<MacroRow | null> {
  const [row] = await executor
    .select()
    .from(macros)
    .where(and(eq(macros.id, macroId), eq(macros.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function findMacroByName(
  executor: DbExecutor,
  organizationId: string,
  name: string,
): Promise<MacroRow | null> {
  const [row] = await executor
    .select()
    .from(macros)
    .where(and(eq(macros.organizationId, organizationId), eq(macros.name, name)))
    .limit(1);
  return row ?? null;
}

export async function insertMacro(
  executor: DbExecutor,
  values: { organizationId: string; name: string; content: string; createdBy?: string | null },
): Promise<MacroRow> {
  const [row] = await executor.insert(macros).values(values).returning();
  if (!row) throw new Error("macros insert returned no row");
  return row;
}

export async function updateMacroRow(
  executor: DbExecutor,
  macroId: string,
  values: { name?: string; content?: string },
): Promise<MacroRow | null> {
  const [row] = await executor
    .update(macros)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(macros.id, macroId))
    .returning();
  return row ?? null;
}

export async function deleteMacroRow(executor: DbExecutor, macroId: string): Promise<boolean> {
  const deleted = await executor.delete(macros).where(eq(macros.id, macroId)).returning();
  return deleted.length > 0;
}

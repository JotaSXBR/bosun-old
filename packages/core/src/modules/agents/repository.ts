import type { DbExecutor } from "@crm/db";
import { schema } from "@crm/db";
import { and, asc, eq } from "drizzle-orm";

const { agents } = schema;

export type AgentRow = typeof agents.$inferSelect;

export async function listAgents(
  executor: DbExecutor,
  organizationId: string,
): Promise<AgentRow[]> {
  return executor
    .select()
    .from(agents)
    .where(eq(agents.organizationId, organizationId))
    .orderBy(asc(agents.name));
}

export async function findAgentById(
  executor: DbExecutor,
  organizationId: string,
  agentId: string,
): Promise<AgentRow | null> {
  const [row] = await executor
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** Dedicated system-role agent ('drafter', 'observer'…) — one per org. */
export async function findAgentByKind(
  executor: DbExecutor,
  organizationId: string,
  kind: string,
): Promise<AgentRow | null> {
  const [row] = await executor
    .select()
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), eq(agents.kind, kind)))
    .limit(1);
  return row ?? null;
}

export type InsertAgentValues = {
  organizationId: string;
  name: string;
  specialty?: string | null;
  status: string;
  kind?: string;
  modelRef?: unknown;
  systemPrompt: string;
  businessRules?: string | null;
  toolsAllowlist: unknown;
  availabilityWindow?: unknown;
  memoryTokenCap?: number | null;
  toolExecutionLimit?: number | null;
  signatureLine?: string | null;
};

export async function insertAgent(
  executor: DbExecutor,
  values: InsertAgentValues,
): Promise<AgentRow> {
  const [row] = await executor.insert(agents).values(values).returning();
  if (!row) throw new Error("agents insert returned no row");
  return row;
}

/**
 * Conflict-safe insert for lazy-created rows (e.g. system-kind agents on
 * the `agents_org_kind_unique` partial index): returns the inserted row,
 * or null when ANY unique constraint fired — the caller re-reads to find
 * the winner or re-runs `insertAgent` to surface the real error.
 */
export async function insertAgentOnce(
  executor: DbExecutor,
  values: InsertAgentValues,
): Promise<AgentRow | null> {
  const [row] = await executor.insert(agents).values(values).onConflictDoNothing().returning();
  return row ?? null;
}

/**
 * Lazy singleton for dedicated agents ('drafter', 'observer'…): reads the
 * per-org row, inserts `defaults` on first use, and falls back to the
 * winner's row when the lazy-create races on `agents_org_kind_unique`.
 */
export async function findOrCreateAgentByKind(
  executor: DbExecutor,
  organizationId: string,
  {
    kind,
    defaults,
  }: { kind: string; defaults: Omit<InsertAgentValues, "organizationId" | "kind"> },
): Promise<AgentRow> {
  const existing = await findAgentByKind(executor, organizationId, kind);
  if (existing) return existing;
  const values = { ...defaults, organizationId, kind };
  const created = await insertAgentOnce(executor, values);
  if (created) return created;
  const winner = await findAgentByKind(executor, organizationId, kind);
  if (winner) return winner;
  // A different unique constraint fired (e.g. agents_org_name_idx on a
  // user-created agent with the same name) — surface the real violation.
  return insertAgent(executor, values);
}

export async function updateAgent(
  executor: DbExecutor,
  agentId: string,
  values: Partial<{
    name: string;
    specialty: string | null;
    status: string;
    modelRef: unknown;
    systemPrompt: string;
    businessRules: string | null;
    toolsAllowlist: unknown;
    availabilityWindow: unknown;
    memoryTokenCap: number | null;
    toolExecutionLimit: number | null;
    signatureLine: string | null;
  }>,
): Promise<AgentRow | undefined> {
  const [row] = await executor
    .update(agents)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(agents.id, agentId))
    .returning();
  return row;
}

export async function deleteAgent(executor: DbExecutor, agentId: string): Promise<boolean> {
  const rows = await executor
    .delete(agents)
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  return rows.length > 0;
}

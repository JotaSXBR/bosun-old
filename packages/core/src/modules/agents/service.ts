import type { Database } from "@crm/db";
import { withTenant } from "@crm/db";
import { captureException } from "@crm/observability";

import { AuthorizationError, DomainError, NotFoundError } from "../../errors";
import { isUniqueViolation } from "../../lib/pg-error";
import type { TenantContext } from "../../tenant/context";
import { assertPermission } from "../../tenant/context";
import { recordAuditEvent } from "../audit";
import type { AgentRow } from "./repository";
import {
  deleteAgent,
  findAgentById,
  insertAgent,
  listAgents as repoListAgents,
  updateAgent as repoUpdateAgent,
} from "./repository";
import type { CreateAgentInput, UpdateAgentInput } from "./schemas";
import { createAgentInput, updateAgentInput } from "./schemas";

function nameTaken(): never {
  throw new DomainError("AGENT_NAME_TAKEN", "An agent with this name already exists");
}

/**
 * System-role agents run the platform pipelines — their config is
 * owner-only (docs/product/ai-agents.md). Org agents incl. 'drafter'
 * stay `ai:manage`.
 */
const SYSTEM_AGENT_KINDS = new Set(["observer"]);

function assertAgentEditable(ctx: TenantContext, kind: string): void {
  if (SYSTEM_AGENT_KINDS.has(kind) && ctx.role !== "owner" && !ctx.isPlatformAdmin) {
    throw new AuthorizationError("Only the org owner can edit system agents");
  }
}

/** Audit is post-commit best-effort — a logging failure must not fail the mutation. */
function audit(
  db: Database,
  ctx: TenantContext,
  { action, id: agentId }: { action: string; id: string },
): void {
  recordAuditEvent(db, ctx, {
    action,
    targetType: "agent",
    targetId: agentId,
    metadata: { agentId },
  }).catch((error: unknown) => captureException(error, { module: "agents", action }));
}

/** Requires ai:read. */
export async function listAgents(db: Database, ctx: TenantContext): Promise<AgentRow[]> {
  assertPermission(ctx, { ai: ["read"] });
  return withTenant(db, ctx.organizationId, (tx) => repoListAgents(tx, ctx.organizationId));
}

/** Requires ai:manage. */
export async function createAgent(
  db: Database,
  ctx: TenantContext,
  input: CreateAgentInput,
): Promise<AgentRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const parsed = createAgentInput.parse(input);
  const agent = await withTenant(db, ctx.organizationId, async (tx) => {
    try {
      return await insertAgent(tx, { organizationId: ctx.organizationId, ...parsed });
    } catch (error) {
      if (isUniqueViolation(error, "agents_org_name_idx")) nameTaken();
      throw error;
    }
  });
  audit(db, ctx, { action: "agent.created", id: agent.id });
  return agent;
}

async function updateAgentRow(
  tx: Parameters<typeof repoUpdateAgent>[0],
  agentId: string,
  fields: Parameters<typeof repoUpdateAgent>[2],
): Promise<AgentRow> {
  let updated: AgentRow | undefined;
  try {
    updated = await repoUpdateAgent(tx, agentId, fields);
  } catch (error) {
    if (isUniqueViolation(error, "agents_org_name_idx")) nameTaken();
    throw error;
  }
  if (!updated) throw new NotFoundError("Agent", agentId);
  return updated;
}

/** Requires ai:manage. */
export async function updateAgent(
  db: Database,
  ctx: TenantContext,
  input: UpdateAgentInput,
): Promise<AgentRow> {
  assertPermission(ctx, { ai: ["manage"] });
  const parsed = updateAgentInput.parse(input);
  const agent = await withTenant(db, ctx.organizationId, async (tx) => {
    const existing = await findAgentById(tx, ctx.organizationId, parsed.agentId);
    if (!existing) throw new NotFoundError("Agent", parsed.agentId);
    assertAgentEditable(ctx, existing.kind);
    const { agentId: _, ...fields } = parsed;
    return updateAgentRow(tx, existing.id, fields);
  });
  audit(db, ctx, { action: "agent.updated", id: agent.id });
  return agent;
}

/** Requires ai:manage. */
export async function deleteAgentById(
  db: Database,
  ctx: TenantContext,
  agentId: string,
): Promise<void> {
  assertPermission(ctx, { ai: ["manage"] });
  await withTenant(db, ctx.organizationId, async (tx) => {
    const existing = await findAgentById(tx, ctx.organizationId, agentId);
    if (!existing) throw new NotFoundError("Agent", agentId);
    assertAgentEditable(ctx, existing.kind);
    await deleteAgent(tx, existing.id);
  });
  audit(db, ctx, { action: "agent.deleted", id: agentId });
}

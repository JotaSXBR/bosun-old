import type { TenantContext } from "@crm/core";
import { Card } from "@crm/design-system/components/card";
import { hasPermission } from "@crm/permissions";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getOrgSettings, listOrgAgents, listOrgLlmCredentials } from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

import { AgentDetail } from "../../agent-detail";
import { ObserverSection } from "../../observer-section";

// Reads the session + database → must never be prerendered at build time.
export const dynamic = "force-dynamic";

type Agents = Awaited<ReturnType<typeof listOrgAgents>>;

function agentRights(ctx: TenantContext) {
  return {
    canManage: hasPermission(ctx.role, { ai: ["manage"] }),
    isOwner: ctx.role === "owner" || ctx.isPlatformAdmin,
  };
}

async function observerPage(ctx: TenantContext, agents: Agents) {
  const t = await getTranslations("settings.ai.agents");
  const { canManage, isOwner } = agentRights(ctx);
  const [settings, credentials] = await Promise.all([
    getOrgSettings(ctx),
    listOrgLlmCredentials(ctx),
  ]);
  const agent = agents.find((a) => a.kind === "observer");
  return (
    <>
      <ObserverSection
        settings={settings}
        canManage={canManage}
        hasCredential={credentials.length > 0}
      />
      {agent ? (
        <AgentDetail agent={agent} canEdit={canManage && isOwner} />
      ) : (
        <Card bodyClassName="text-ink-muted p-6 text-sm">{t("observerMissing")}</Card>
      )}
    </>
  );
}

function agentPage(ctx: TenantContext, agents: Agents, id: string) {
  const agent = agents.find((a) => a.id === id);
  if (!agent) notFound();
  const { canManage, isOwner } = agentRights(ctx);
  return (
    <AgentDetail agent={agent} canEdit={canManage && (agent.kind !== "observer" || isOwner)} />
  );
}

/**
 * Agent detail — IA spec §3: Identidade · Comportamento · Modelo · Avançado.
 * `id="observer"` is the hybrid system page: org-level observer params
 * (ai:manage) plus the agent row's prompt/model (owner only).
 */
export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireTenantContext();
  const agents = await listOrgAgents(ctx);
  return id === "observer" ? observerPage(ctx, agents) : agentPage(ctx, agents, id);
}

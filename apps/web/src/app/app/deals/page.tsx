import type { TenantContext } from "@crm/core";
import { NotFoundError } from "@crm/core";
import type { FunnelRow } from "@crm/core/leads";
import { Button } from "@crm/design-system/components/button";
import { PageHeader } from "@crm/design-system/templates/page-header";
import { hasPermission } from "@crm/permissions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { KanbanBoard } from "@/components/kanban-board";
import { getFunnelBoard, listOrgFunnels, listOrgLabels } from "@/server/services";
import { requireTenantContext } from "@/server/tenant";

// Reads the session + database → must never be prerendered at build time.
export const dynamic = "force-dynamic";

function firstFunnel(funnels: FunnelRow[], requested?: string): FunnelRow | undefined {
  return funnels.find((f) => f.id === requested) ?? funnels[0];
}

function EmptyFunnel({
  title,
  body,
  cta,
  canManage,
}: {
  title: string;
  body: string;
  cta: string;
  canManage: boolean;
}) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <PageHeader title={title} />
      <div className="rounded-lg border border-dashed p-12 text-center" data-testid="empty-funnel">
        <p className="text-ink-muted text-sm">{body}</p>
        {canManage && (
          <div className="mt-4">
            <Button variant="primary" iconLeft="plus" asChild>
              <Link href="/app/settings/sales/funnels">{cta}</Link>
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}

async function loadBoard(ctx: TenantContext, funnelId: string) {
  try {
    return await getFunnelBoard(ctx, funnelId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ funnel?: string }>;
}) {
  const t = await getTranslations("leads");
  const ctx = await requireTenantContext();
  const { funnel: requested } = await searchParams;
  const [funnels, labels] = await Promise.all([listOrgFunnels(ctx), listOrgLabels(ctx)]);
  const canManage = hasPermission(ctx.role, { leads: ["manage"] });

  const funnel = firstFunnel(funnels, requested);
  if (!funnel) {
    return (
      <EmptyFunnel
        title={t("funnel")}
        body={t("emptyFunnel")}
        cta={t("createFunnel")}
        canManage={canManage}
      />
    );
  }

  const board = await loadBoard(ctx, funnel.id);

  return (
    <main className="space-y-4 p-8">
      <PageHeader title={t("funnel")} />
      <KanbanBoard
        board={board}
        funnels={funnels}
        labels={labels}
        canWrite={hasPermission(ctx.role, { leads: ["write"] })}
        canManage={canManage}
      />
    </main>
  );
}

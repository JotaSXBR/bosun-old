"use client";

import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { ConvertToDealDialog } from "@/components/convert-to-deal-dialog";
import { DealValue } from "@/components/deal-value";
import { moveDealAction } from "@/server/actions/leads";
import type { ConversationDeal, FunnelWithStages } from "@/server/services";

type Deal = NonNullable<ConversationDeal>;

function useChangeStage(deal: ConversationDeal) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function changeStage(nextStageId: string) {
    if (!deal) return;
    startTransition(async () => {
      // position clamps to the end of the target stage.
      const result = await moveDealAction({
        dealId: deal.id,
        stageId: nextStageId,
        position: 9999,
      });
      if (!result.ok) toast.error(result.error);
      router.refresh();
    });
  }
  return { pending, changeStage };
}

function DealSummary({
  deal,
  dealFunnel,
  canWrite,
}: {
  deal: Deal;
  dealFunnel: FunnelWithStages | undefined;
  canWrite: boolean;
}) {
  const t = useTranslations("leads");
  const { pending, changeStage } = useChangeStage(deal);
  return (
    <>
      <div>
        <p className="font-medium">{deal.title}</p>
        <p className="text-ink-muted text-xs">
          {deal.funnelName}
          <DealValue dealId={deal.id} valueCents={deal.valueCents} canWrite={canWrite} t={t} />
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="deal-stage-select" className="text-xs">
          {t("panel.stage")}
        </Label>
        <Select
          options={(dealFunnel?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
          value={deal.stageId}
          onChange={changeStage}
          disabled={!canWrite || pending}
          size="sm"
          id="deal-stage-select"
        />
      </div>
      <Link
        href={`/app/deals?funnel=${deal.funnelId}`}
        className="text-ink-muted text-xs underline"
      >
        {t("panel.viewKanban")}
      </Link>
    </>
  );
}

type LeadPanelProps = {
  conversationId: string;
  contactName: string;
  deal: ConversationDeal;
  funnels: FunnelWithStages[];
  canWrite: boolean;
};

export function ConversationLeadPanel({
  conversationId,
  contactName,
  deal,
  funnels,
  canWrite,
}: LeadPanelProps) {
  const t = useTranslations("leads");
  const [convertOpen, setConvertOpen] = useState(false);
  const dealFunnel = deal ? funnels.find((f) => f.funnel.id === deal.funnelId) : undefined;
  const readyFunnels = funnels.filter((f) => f.stages.length > 0);

  return (
    <aside className="w-full shrink-0 space-y-4 lg:w-72" data-testid="lead-panel">
      <Card bodyClassName="space-y-3 text-sm" title={t("panel.lead")}>
        {deal ? (
          <DealSummary deal={deal} dealFunnel={dealFunnel} canWrite={canWrite} />
        ) : canWrite && readyFunnels.length > 0 ? (
          <>
            <p className="text-ink-muted text-xs">{t("panel.notLead")}</p>
            <Button
              variant="primary"
              size="sm"
              iconLeft="sparkles"
              onClick={() => setConvertOpen(true)}
              className="w-full"
            >
              {t("panel.convertTitle")}
            </Button>
          </>
        ) : (
          <p className="text-ink-muted text-xs">
            {readyFunnels.length === 0 ? t("panel.noFunnelHint") : t("panel.noDeal")}
          </p>
        )}
      </Card>

      <ConvertToDealDialog
        conversationId={conversationId}
        contactName={contactName}
        funnels={readyFunnels}
        open={convertOpen}
        onOpenChange={setConvertOpen}
      />
    </aside>
  );
}

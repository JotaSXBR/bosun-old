"use client";

import { Button } from "@crm/design-system/components/button";
import { Dialog } from "@crm/design-system/components/dialog";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { createDealFromConversationAction } from "@/server/actions/leads";
import type { FunnelWithStages } from "@/server/services";

/** Radix Select rejects "" — empty form state maps to `undefined`. */
const selectedOrUndefined = (v: string) => v || undefined;

type ConvertProps = {
  conversationId: string;
  contactName: string;
  funnels: FunnelWithStages[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function useConvertForm({ conversationId, contactName, funnels, onOpenChange }: ConvertProps) {
  const t = useTranslations("leads");
  const router = useRouter();
  const [funnelId, setFunnelId] = useState(funnels[0]?.funnel.id ?? "");
  const funnel = funnels.find((f) => f.funnel.id === funnelId) ?? funnels[0];
  const [stageId, setStageId] = useState(funnel?.stages[0]?.id ?? "");
  const [title, setTitle] = useState(contactName);
  const [pending, startTransition] = useTransition();

  function selectFunnel(next: string) {
    setFunnelId(next);
    const f = funnels.find((x) => x.funnel.id === next);
    setStageId(f?.stages[0]?.id ?? "");
  }

  const submit = () =>
    startTransition(async () => {
      const result = await createDealFromConversationAction({
        conversationId,
        funnelId,
        stageId,
        title: title.trim(),
      });
      if (result.ok) {
        toast.success(t("panel.converted"));
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });

  return { funnelId, stageId, setStageId, title, setTitle, funnel, selectFunnel, pending, submit };
}

type ConvertForm = ReturnType<typeof useConvertForm>;

function ConvertFields({ form, funnels }: { form: ConvertForm; funnels: FunnelWithStages[] }) {
  const t = useTranslations("leads");
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="lead-title">{t("panel.dealTitle")}</Label>
        <Input
          shape="rounded"
          id="lead-title"
          value={form.title}
          onChange={(e) => form.setTitle(e.target.value)}
          maxLength={200}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="lead-funnel">{t("funnel")}</Label>
          <Select
            options={funnels.map((f) => ({ value: f.funnel.id, label: f.funnel.name }))}
            value={selectedOrUndefined(form.funnelId)}
            onChange={form.selectFunnel}
            id="lead-funnel"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead-stage">{t("panel.stage")}</Label>
          <Select
            options={(form.funnel?.stages ?? []).map((s) => ({ value: s.id, label: s.name }))}
            value={selectedOrUndefined(form.stageId)}
            onChange={form.setStageId}
            id="lead-stage"
          />
        </div>
      </div>
    </div>
  );
}

export function ConvertToDealDialog(props: ConvertProps) {
  const t = useTranslations("leads");
  const form = useConvertForm(props);

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onOpenChange(false)}
      title={t("panel.convertTitle")}
      description={t("panel.convertDescription")}
      footer={
        <Button
          variant="primary"
          disabled={!form.title.trim() || !form.stageId || form.pending}
          onClick={form.submit}
        >
          {t("dealForm.createSubmit")}
        </Button>
      }
    >
      <ConvertFields form={form} funnels={props.funnels} />
    </Dialog>
  );
}

"use client";

import type { PaletteColor, StageRow } from "@crm/core/leads";
import { COLOR_PALETTE } from "@crm/core/leads/schemas";
import { FUNNEL_TEMPLATES } from "@crm/core/leads/templates";
import { Button } from "@crm/design-system/components/button";
import { Dialog } from "@crm/design-system/components/dialog";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { cn } from "@crm/design-system/lib/utils";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { paletteStyle } from "@/components/palette";
import {
  createFunnelAction,
  createStageAction,
  deleteFunnelAction,
  deleteStageAction,
  updateStageAction,
} from "@/server/actions/leads";

function ColorField({
  value,
  onChange,
}: {
  value: PaletteColor;
  onChange: (c: PaletteColor) => void;
}) {
  const t = useTranslations("leads");
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_PALETTE.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={t("colorAria", { color })}
          onClick={() => onChange(color)}
          className={cn(
            "size-6 rounded-full ring-offset-2",
            paletteStyle(color).dot,
            value === color && "ring-ink ring-2",
          )}
        />
      ))}
    </div>
  );
}

type NewFunnelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirectBase?: string;
};

function useCreateFunnel({ onOpenChange, redirectBase = "/app/deals" }: NewFunnelProps) {
  const t = useTranslations("leads");
  const router = useRouter();
  const [name, setName] = useState("");
  const [templateRef, setTemplateRef] = useState<string>("");
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const result = await createFunnelAction({
        name,
        templateRef: templateRef || undefined,
      });
      if (result.ok) {
        toast.success(t("funnelForm.created"));
        onOpenChange(false);
        router.push(`${redirectBase}?funnel=${result.data.id}`);
      } else {
        toast.error(result.error);
      }
    });
  }
  return { name, setName, templateRef, setTemplateRef, pending, submit };
}

type FunnelForm = ReturnType<typeof useCreateFunnel>;

function FunnelFields({ form }: { form: FunnelForm }) {
  const t = useTranslations("leads");
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="funnel-name">{t("funnelForm.name")}</Label>
        <Input
          shape="rounded"
          id="funnel-name"
          value={form.name}
          onChange={(e) => form.setName(e.target.value)}
          placeholder={t("funnelForm.namePlaceholder")}
          maxLength={100}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="funnel-template">{t("funnelForm.template")}</Label>
        <Select
          options={FUNNEL_TEMPLATES.map((tpl) => ({
            value: tpl.ref,
            label: `${tpl.label} — ${t("funnelForm.templateStages", { count: tpl.stages.length })}`,
          }))}
          value={form.templateRef || undefined}
          onChange={form.setTemplateRef}
          placeholder={t("funnelForm.templateEmpty")}
          id="funnel-template"
        />
      </div>
    </div>
  );
}

export function NewFunnelDialog(props: NewFunnelProps) {
  const t = useTranslations("leads");
  const form = useCreateFunnel(props);

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onOpenChange(false)}
      title={t("funnelForm.newTitle")}
      description={t("funnelForm.newDescription")}
      footer={
        <Button
          variant="primary"
          onClick={form.submit}
          disabled={!form.name.trim() || form.pending}
        >
          {t("createFunnel")}
        </Button>
      }
    >
      <FunnelFields form={form} />
    </Dialog>
  );
}

type StageDialogProps = {
  funnelId: string;
  stage?: StageRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function useStageForm({ funnelId, stage, onOpenChange }: StageDialogProps) {
  const router = useRouter();
  const [name, setName] = useState(stage?.name ?? "");
  const [color, setColor] = useState<PaletteColor>((stage?.color ?? "gray") as PaletteColor);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const result = stage
        ? await updateStageAction({ stageId: stage.id, name, color })
        : await createStageAction({ funnelId, name, color });
      if (result.ok) {
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }
  return { name, setName, color, setColor, pending, submit };
}

export function StageDialog(props: StageDialogProps) {
  const t = useTranslations("leads");
  const tc = useTranslations("common");
  const { name, setName, color, setColor, pending, submit } = useStageForm(props);
  const editing = Boolean(props.stage);

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onOpenChange(false)}
      title={editing ? t("funnelForm.stageEditTitle") : t("funnelForm.stageNewTitle")}
      footer={
        <Button variant="primary" onClick={submit} disabled={!name.trim() || pending}>
          {editing ? tc("save") : t("funnelForm.addStage")}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="stage-name">{t("funnelForm.name")}</Label>
          <Input
            shape="rounded"
            id="stage-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("funnelForm.color")}</Label>
          <ColorField value={color} onChange={setColor} />
        </div>
      </div>
    </Dialog>
  );
}

export function DeleteFunnelDialog({
  funnelId,
  funnelName,
  open,
  onOpenChange,
  redirectBase = "/app/deals",
}: {
  funnelId: string;
  funnelName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  redirectBase?: string;
}) {
  const t = useTranslations("leads");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t("deleteFunnel")}
      description={t("funnelForm.deleteFunnelConfirm", { name: funnelName })}
      footer={
        <Button
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteFunnelAction(funnelId);
              if (result.ok) {
                toast.success(t("funnelForm.funnelDeleted"));
                onOpenChange(false);
                router.push(redirectBase);
              } else {
                toast.error(result.error);
              }
            })
          }
        >
          {t("deleteFunnel")}
        </Button>
      }
    ></Dialog>
  );
}

export function DeleteStageDialog({
  stage,
  open,
  onOpenChange,
}: {
  stage: StageRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("leads");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t("deleteStage")}
      description={t("funnelForm.deleteStageConfirm", { name: stage.name })}
      footer={
        <Button
          variant="danger"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteStageAction(stage.id);
              if (result.ok) {
                onOpenChange(false);
                router.refresh();
              } else {
                toast.error(result.error);
              }
            })
          }
        >
          {t("deleteStage")}
        </Button>
      }
    ></Dialog>
  );
}

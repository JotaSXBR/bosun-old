"use client";

import type { DealCardRow, StageRow } from "@crm/core/leads";
import { Button } from "@crm/design-system/components/button";
import { Dialog } from "@crm/design-system/components/dialog";
import { IconButton } from "@crm/design-system/components/icon-button";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { NewContactDialog } from "@/components/contact-dialogs";
import { ContactSelect } from "@/components/contact-select";
import { useOnOpen } from "@/lib/use-on-open";
import { createDealAction, updateDealAction } from "@/server/actions/leads";

function toReais(valueCents: number): string {
  return valueCents > 0 ? (valueCents / 100).toFixed(2).replace(".", ",") : "";
}

function fromReais(raw: string): number | undefined {
  const parsed = Number(raw.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : undefined;
}

interface AttrRow {
  key: string;
  value: string;
}

function attrsToRows(attrs: unknown): AttrRow[] {
  if (!attrs || typeof attrs !== "object") return [];
  return Object.entries(attrs).map(([key, v]) => ({ key, value: String(v ?? "") }));
}

function rowsToAttrs(rows: AttrRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}

function AttrRowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: AttrRow;
  onChange: (patch: Partial<AttrRow>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("leads");
  return (
    <div className="flex gap-2">
      <Input
        shape="rounded"
        value={row.key}
        onChange={(e) => onChange({ key: e.target.value })}
        placeholder={t("dealForm.attrKey")}
        className="w-2/5"
        maxLength={100}
      />
      <Input
        shape="rounded"
        value={row.value}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder={t("dealForm.attrValue")}
        className="flex-1"
        maxLength={500}
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        icon="x"
        label={t("dealForm.removeField")}
        onClick={onRemove}
      />
    </div>
  );
}

function CustomAttrsFields({
  attrs,
  setAttrs,
}: {
  attrs: AttrRow[];
  setAttrs: (a: AttrRow[]) => void;
}) {
  const t = useTranslations("leads");
  return (
    <div className="space-y-1.5">
      <Label>{t("dealForm.customAttrs")}</Label>
      {attrs.map((row, index) => (
        <AttrRowEditor
          key={index}
          row={row}
          onChange={(patch) =>
            setAttrs(attrs.map((r, i) => (i === index ? { ...r, ...patch } : r)))
          }
          onRemove={() => setAttrs(attrs.filter((_, i) => i !== index))}
        />
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        iconLeft="plus"
        onClick={() => setAttrs([...attrs, { key: "", value: "" }])}
      >
        {t("dealForm.addField")}
      </Button>
    </div>
  );
}

function pickStageId(
  deal: DealCardRow | undefined,
  defaultStageId: string | undefined,
  stages: StageRow[],
): string {
  return defaultStageId ?? deal?.stageId ?? stages[0]?.id ?? "";
}

interface DealFormState {
  title: string;
  stageId: string;
  contactId: string;
  value: string;
  attrs: AttrRow[];
}

type FormFieldsProps = {
  editing: boolean;
  stages: StageRow[];
  form: DealFormState;
  setForm: (patch: Partial<DealFormState>) => void;
};

function DealContactField({ form, setForm }: Pick<FormFieldsProps, "form" | "setForm">) {
  const t = useTranslations("leads");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [contactBump, setContactBump] = useState(0);
  return (
    <div className="space-y-1.5">
      <Label>{t("dealForm.contact")}</Label>
      <ContactSelect
        value={form.contactId}
        onChange={(contactId) => setForm({ contactId })}
        refreshKey={contactBump}
        onCreateClick={(query) => {
          setCreateName(query);
          setCreateOpen(true);
        }}
      />
      <NewContactDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialName={createName}
        onCreated={(id) => {
          setForm({ contactId: id });
          setContactBump((b) => b + 1);
        }}
      />
    </div>
  );
}

function StageValueFields({ editing, stages, form, setForm }: FormFieldsProps) {
  const t = useTranslations("leads");
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="deal-stage">{t("dealForm.stage")}</Label>
        <Select
          options={stages.map((s) => ({ value: s.id, label: s.name }))}
          value={form.stageId || undefined}
          onChange={(stageId) => setForm({ stageId })}
          disabled={editing}
          id="deal-stage"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="deal-value">{t("dealForm.value")}</Label>
        <Input
          shape="rounded"
          id="deal-value"
          value={form.value}
          onChange={(e) => setForm({ value: e.target.value })}
          placeholder="0,00"
          inputMode="decimal"
        />
      </div>
    </div>
  );
}

function DealFormFields(props: FormFieldsProps) {
  const { editing, form, setForm } = props;
  const t = useTranslations("leads");
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="deal-title">{t("dealForm.title")}</Label>
        <Input
          shape="rounded"
          id="deal-title"
          value={form.title}
          onChange={(e) => setForm({ title: e.target.value })}
          maxLength={200}
        />
      </div>
      {!editing && <DealContactField form={form} setForm={setForm} />}
      <StageValueFields {...props} />
      <CustomAttrsFields attrs={form.attrs} setAttrs={(attrs) => setForm({ attrs })} />
    </div>
  );
}

type DealFormArgs = {
  deal: DealCardRow | undefined;
  defaultStageId: string | undefined;
  stages: StageRow[];
  open: boolean;
};

/** Form state, reset each time the dialog opens (mounted once, reused for create/edit). */
function useDealForm({ deal, defaultStageId, stages, open }: DealFormArgs) {
  const initialForm = (): DealFormState => ({
    title: deal?.title ?? "",
    stageId: pickStageId(deal, defaultStageId, stages),
    contactId: deal?.contactId ?? "",
    value: toReais(deal?.valueCents ?? 0),
    attrs: attrsToRows(deal?.customAttributes ?? {}),
  });
  const [form, setFormState] = useState<DealFormState>(initialForm);
  useOnOpen(open, () => setFormState(initialForm()));
  const setForm = (patch: Partial<DealFormState>) =>
    setFormState((prev) => ({ ...prev, ...patch }));
  return { form, setForm };
}

type DealDialogProps = {
  funnelId: string;
  stages: StageRow[];
  defaultStageId?: string;
  deal?: DealCardRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function useDealSubmit(props: DealDialogProps, form: DealFormState) {
  const { funnelId, deal, onOpenChange } = props;
  const t = useTranslations("leads");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { title, stageId, contactId, value, attrs } = form;

  function submit() {
    startTransition(async () => {
      const valueCents = value.trim() ? fromReais(value) : undefined;
      const customAttributes = rowsToAttrs(attrs);
      const result = deal
        ? await updateDealAction({ dealId: deal.id, title, valueCents, customAttributes })
        : await createDealAction({
            funnelId,
            stageId,
            contactId,
            title,
            valueCents,
            customAttributes,
          });
      if (result.ok) {
        toast.success(deal ? t("dealForm.updated") : t("dealForm.created"));
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }
  return { submit, pending };
}

export function DealFormDialog(props: DealDialogProps) {
  const { stages, defaultStageId, deal, open, onOpenChange } = props;
  const t = useTranslations("leads");
  const tc = useTranslations("common");
  const editing = Boolean(deal);
  const { form, setForm } = useDealForm({ deal, defaultStageId, stages, open });
  const { submit, pending } = useDealSubmit(props, form);
  const canSubmit = form.title.trim() && form.stageId && (editing || form.contactId) && !pending;

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={editing ? t("dealForm.editTitle") : t("dealForm.newTitle")}
      footer={
        <Button variant="primary" onClick={submit} disabled={!canSubmit}>
          {editing ? tc("save") : t("dealForm.createSubmit")}
        </Button>
      }
    >
      <DealFormFields editing={editing} stages={stages} form={form} setForm={setForm} />
    </Dialog>
  );
}

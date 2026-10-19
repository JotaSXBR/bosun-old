"use client";

import { Button } from "@crm/design-system/components/button";
import { Dialog } from "@crm/design-system/components/dialog";
import { useTranslations } from "next-intl";

import type { ProposeForm } from "./brain-propose-fields";
import { ProposeFields } from "./brain-propose-fields";

export type { ProposeForm } from "./brain-propose-fields";
export { emptyProposeForm } from "./brain-propose-fields";

function isProposeValid(form: ProposeForm): boolean {
  const scopeReady =
    form.scope === "org" ||
    (form.scope === "team" && form.teamId !== "") ||
    (form.scope === "contact" && form.contactId !== "");
  return form.content.trim().length > 0 && form.rationale.trim().length > 0 && scopeReady;
}

function ProposeFooter({
  pending,
  valid,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  valid: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("settings.ai.brain");
  const tc = useTranslations("common");
  return (
    <>
      <Button variant="secondary" onClick={onCancel} disabled={pending}>
        {tc("cancel")}
      </Button>
      <Button
        variant="primary"
        onClick={onSubmit}
        disabled={pending || !valid}
        data-testid="brain-propose-submit"
      >
        {t("propose")}
      </Button>
    </>
  );
}

/** Staging form — the proposal lands in the suggestion inbox, never in canon directly. */
export function BrainProposeDialog({
  open,
  onOpenChange,
  teams,
  form,
  setForm,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: Array<{ id: string; name: string }>;
  form: ProposeForm;
  setForm: (v: ProposeForm) => void;
  pending: boolean;
  onSubmit: () => void;
}) {
  const t = useTranslations("settings.ai.brain");
  const set = <K extends keyof ProposeForm>(key: K, value: ProposeForm[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      title={t("propose")}
      description={t("description")}
      footer={
        <ProposeFooter
          pending={pending}
          valid={isProposeValid(form)}
          onCancel={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      }
    >
      <ProposeFields form={form} set={set} teams={teams} pending={pending} />
    </Dialog>
  );
}

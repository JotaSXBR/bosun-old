"use client";

import type { ObserverMode, OrganizationSettingsRow } from "@crm/core/organizations";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { Switch } from "@crm/design-system/components/switch";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useRunAction } from "@/lib/use-run-action";
import { updateObserverSettingsAction } from "@/server/actions/settings";

const inRange = (minutes: string) => Number(minutes) >= 5 && Number(minutes) <= 120;

type Draft = {
  mode: ObserverMode;
  intervalMinutes: string;
  idleMinutes: string;
  autoDraft: boolean;
  transcribeAudio: boolean;
};

const toDraft = (settings: OrganizationSettingsRow): Draft => ({
  mode: settings.aiObserverMode as ObserverMode,
  intervalMinutes: String(settings.observerIntervalMinutes),
  idleMinutes: String(settings.observerIdleMinutes),
  autoDraft: settings.observerAutoDraft,
  transcribeAudio: settings.aiTranscribeAudio,
});

const toSettingsInput = (draft: Draft) => ({
  aiObserverMode: draft.mode,
  observerIntervalMinutes: Number(draft.intervalMinutes),
  observerIdleMinutes: Number(draft.idleMinutes),
  observerAutoDraft: draft.autoDraft,
  aiTranscribeAudio: draft.transcribeAudio,
});

type FieldProps = {
  draft: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  disabled: boolean;
};

function ModeField({ draft, set, disabled }: FieldProps) {
  const t = useTranslations("settings.ai.observer");
  return (
    <div className="space-y-1">
      <Label>{t("mode")}</Label>
      <Select
        options={[
          { value: "off", label: t("modeOff") },
          { value: "on_close", label: t("modeOnClose") },
          { value: "interval", label: t("modeInterval") },
          { value: "realtime", label: t("modeRealtime"), disabled: true },
        ]}
        value={draft.mode}
        onChange={(v) => set("mode", v as ObserverMode)}
        disabled={disabled}
      />
      <p className="text-ink-muted text-xs">{t("modeHint")}</p>
    </div>
  );
}

function TranscribeField({ draft, set, disabled }: FieldProps) {
  const t = useTranslations("settings.ai.observer");
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.transcribeAudio}
          onChange={(v) => set("transcribeAudio", v)}
          disabled={disabled}
          data-testid="ai-transcribe-audio"
        />
        {t("transcribeAudio")}
      </label>
      <p className="text-ink-muted text-xs">{t("transcribeAudioHint")}</p>
    </div>
  );
}

/**
 * Observer modes (docs/product/ai-agents.md): off | on_close | interval.
 * `realtime` stays a disabled option until the observer tool loop ships —
 * the cost warning is on the label so nobody picks it blind.
 */
export function ObserverSection({
  settings,
  canManage,
  hasCredential,
}: {
  settings: OrganizationSettingsRow;
  canManage: boolean;
  hasCredential: boolean;
}) {
  const t = useTranslations("settings.ai.observer");
  const { pending, run } = useRunAction();
  const [draft, setDraft] = useState<Draft>(() => toDraft(settings));
  const set: FieldProps["set"] = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const field = { draft, set, disabled: !canManage || pending };
  const valid = inRange(draft.intervalMinutes) && inRange(draft.idleMinutes);

  const save = () => run(updateObserverSettingsAction(toSettingsInput(draft)), t("saved"));

  return (
    <Card bodyClassName="space-y-4" title={t("title")} subtitle={t("description")}>
      <ModeField {...field} />
      {draft.mode === "interval" && <IntervalFields {...field} />}
      <TranscribeField {...field} />
      {!hasCredential && draft.mode !== "off" && (
        <p className="text-warning text-xs" data-testid="observer-no-credential">
          {t("noCredential")}
        </p>
      )}
      {canManage && (
        <Button
          variant="primary"
          size="sm"
          disabled={pending || !valid}
          onClick={save}
          data-testid="observer-save"
        >
          {t("save")}
        </Button>
      )}
    </Card>
  );
}

function MinutesField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        shape="rounded"
        type="number"
        min={5}
        max={120}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      <p className="text-ink-muted text-xs">{hint}</p>
    </div>
  );
}

/** Scan cadence + idle threshold + auto-draft — only meaningful in interval mode. */
function IntervalFields({ draft, set, disabled }: FieldProps) {
  const t = useTranslations("settings.ai.observer");
  return (
    <div className="space-y-4" data-testid="observer-interval-fields">
      <div className="grid gap-4 sm:grid-cols-2">
        <MinutesField
          id="observer-interval"
          label={t("interval")}
          hint={t("intervalHint")}
          value={draft.intervalMinutes}
          onChange={(v) => set("intervalMinutes", v)}
          disabled={disabled}
        />
        <MinutesField
          id="observer-idle"
          label={t("idle")}
          hint={t("idleHint")}
          value={draft.idleMinutes}
          onChange={(v) => set("idleMinutes", v)}
          disabled={disabled}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.autoDraft}
          onChange={(v) => set("autoDraft", v)}
          disabled={disabled}
          data-testid="observer-auto-draft"
        />
        {t("autoDraft")}
      </label>
      <p className="text-ink-muted text-xs">{t("autoDraftHint")}</p>
    </div>
  );
}

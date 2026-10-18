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
  const [mode, setMode] = useState<ObserverMode>(settings.aiObserverMode as ObserverMode);
  const [intervalMinutes, setIntervalMinutes] = useState(String(settings.observerIntervalMinutes));
  const [idleMinutes, setIdleMinutes] = useState(String(settings.observerIdleMinutes));
  const [autoDraft, setAutoDraft] = useState(settings.observerAutoDraft);
  const [transcribeAudio, setTranscribeAudio] = useState(settings.aiTranscribeAudio);

  const valid = inRange(intervalMinutes) && inRange(idleMinutes);

  const save = () =>
    run(
      updateObserverSettingsAction({
        aiObserverMode: mode,
        observerIntervalMinutes: Number(intervalMinutes),
        observerIdleMinutes: Number(idleMinutes),
        observerAutoDraft: autoDraft,
        aiTranscribeAudio: transcribeAudio,
      }),
      t("saved"),
    );

  return (
    <Card bodyClassName="space-y-4" title={t("title")} subtitle={t("description")}>
      <div className="space-y-1">
        <Label>{t("mode")}</Label>
        <Select
          options={[
            { value: "off", label: t("modeOff") },
            { value: "on_close", label: t("modeOnClose") },
            { value: "interval", label: t("modeInterval") },
            { value: "realtime", label: t("modeRealtime"), disabled: true },
          ]}
          value={mode}
          onChange={(v) => setMode(v as ObserverMode)}
          disabled={!canManage || pending}
        />
        <p className="text-ink-muted text-xs">{t("modeHint")}</p>
      </div>
      {mode === "interval" && (
        <IntervalFields
          disabled={!canManage || pending}
          intervalMinutes={intervalMinutes}
          idleMinutes={idleMinutes}
          autoDraft={autoDraft}
          onInterval={setIntervalMinutes}
          onIdle={setIdleMinutes}
          onAutoDraft={setAutoDraft}
        />
      )}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={transcribeAudio}
            onChange={setTranscribeAudio}
            disabled={!canManage || pending}
            data-testid="ai-transcribe-audio"
          />
          {t("transcribeAudio")}
        </label>
        <p className="text-ink-muted text-xs">{t("transcribeAudioHint")}</p>
      </div>
      {!hasCredential && mode !== "off" && (
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

/** Scan cadence + idle threshold + auto-draft — only meaningful in interval mode. */
function IntervalFields({
  disabled,
  intervalMinutes,
  idleMinutes,
  autoDraft,
  onInterval,
  onIdle,
  onAutoDraft,
}: {
  disabled: boolean;
  intervalMinutes: string;
  idleMinutes: string;
  autoDraft: boolean;
  onInterval: (v: string) => void;
  onIdle: (v: string) => void;
  onAutoDraft: (v: boolean) => void;
}) {
  const t = useTranslations("settings.ai.observer");
  return (
    <div className="space-y-4" data-testid="observer-interval-fields">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="observer-interval">{t("interval")}</Label>
          <Input
            id="observer-interval"
            shape="rounded"
            type="number"
            min={5}
            max={120}
            value={intervalMinutes}
            onChange={(e) => onInterval(e.target.value)}
            disabled={disabled}
          />
          <p className="text-ink-muted text-xs">{t("intervalHint")}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="observer-idle">{t("idle")}</Label>
          <Input
            id="observer-idle"
            shape="rounded"
            type="number"
            min={5}
            max={120}
            value={idleMinutes}
            onChange={(e) => onIdle(e.target.value)}
            disabled={disabled}
          />
          <p className="text-ink-muted text-xs">{t("idleHint")}</p>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={autoDraft}
          onChange={onAutoDraft}
          disabled={disabled}
          data-testid="observer-auto-draft"
        />
        {t("autoDraft")}
      </label>
      <p className="text-ink-muted text-xs">{t("autoDraftHint")}</p>
    </div>
  );
}

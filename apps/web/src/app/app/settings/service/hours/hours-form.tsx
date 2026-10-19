"use client";

import type { BusinessHours } from "@crm/core/organizations";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { IconButton } from "@crm/design-system/components/icon-button";
import { Input } from "@crm/design-system/components/input";
import { Switch } from "@crm/design-system/components/switch";
import { Textarea } from "@crm/design-system/components/textarea";
import { toast } from "@crm/design-system/components/toast";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { updateOrgSettingsAction } from "@/server/actions/settings";

type Window = { start: string; end: string };

const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const MAX_WINDOWS = 2; // spec: up to 2 windows/day (schema allows 4)

interface DayState {
  open: boolean;
  windows: Window[];
}

function toDayState(businessHours: BusinessHours | null): Record<string, DayState> {
  const windows = businessHours?.windows ?? {};
  return Object.fromEntries(
    DAY_ORDER.map((day) => {
      const dayWindows = windows[day] ?? [];
      return [day, { open: dayWindows.length > 0, windows: dayWindows.map((w) => ({ ...w })) }];
    }),
  );
}

function toBusinessHours(days: Record<string, DayState>): BusinessHours {
  const windows: BusinessHours["windows"] = {};
  for (const day of DAY_ORDER) {
    const state = days[day];
    if (state?.open && state.windows.length > 0) windows[day] = state.windows;
  }
  return { windows };
}

function WindowInput({
  value,
  ariaLabel,
  onChange,
}: {
  value: string;
  ariaLabel: string;
  onChange: (v: string) => void;
}) {
  return (
    <Input
      type="time"
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="w-28"
    />
  );
}

function WindowSpan({
  window: w,
  index: i,
  dayLabel,
  removable,
  onPatch,
  onRemove,
}: {
  window: Window;
  index: number;
  dayLabel: string;
  removable: boolean;
  onPatch: (i: number, patch: Partial<Window>) => void;
  onRemove: (i: number) => void;
}) {
  const t = useTranslations("settings.hours");
  return (
    <span className="flex items-center gap-1">
      <WindowInput
        value={w.start}
        ariaLabel={`${dayLabel} ${t("from")}`}
        onChange={(v) => onPatch(i, { start: v })}
      />
      <span className="text-ink-muted text-xs">–</span>
      <WindowInput
        value={w.end}
        ariaLabel={`${dayLabel} ${t("to")}`}
        onChange={(v) => onPatch(i, { end: v })}
      />
      {removable && (
        <IconButton
          size="sm"
          variant="ghost"
          icon="x"
          label={t("removeWindow")}
          onClick={() => onRemove(i)}
        />
      )}
    </span>
  );
}

function DayWindows({
  day,
  state,
  onChange,
}: {
  day: string;
  state: DayState;
  onChange: (next: DayState) => void;
}) {
  const t = useTranslations("settings.hours");
  const setWindow = (i: number, patch: Partial<Window>) =>
    onChange({
      ...state,
      windows: state.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)),
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.windows.map((w, i) => (
        <WindowSpan
          key={i}
          window={w}
          index={i}
          dayLabel={t(`days.${day}`)}
          removable={state.windows.length > 1}
          onPatch={setWindow}
          onRemove={(j) => onChange({ ...state, windows: state.windows.filter((_, k) => k !== j) })}
        />
      ))}
      {state.windows.length < MAX_WINDOWS && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({ ...state, windows: [...state.windows, { start: "09:00", end: "18:00" }] })
          }
        >
          {t("addWindow")}
        </Button>
      )}
    </div>
  );
}

function DayRow({
  day,
  state,
  onChange,
}: {
  day: string;
  state: DayState;
  onChange: (next: DayState) => void;
}) {
  const t = useTranslations("settings.hours");
  return (
    <div className="flex flex-wrap items-center gap-3 py-2">
      <Switch
        checked={state.open}
        onChange={(open) =>
          onChange({
            open,
            windows:
              open && state.windows.length === 0
                ? [{ start: "09:00", end: "18:00" }]
                : state.windows,
          })
        }
        label={t(`days.${day}`)}
      />
      {state.open ? (
        <DayWindows day={day} state={state} onChange={onChange} />
      ) : (
        <span className="text-ink-muted text-xs">{t("closed")}</span>
      )}
    </div>
  );
}

type HoursT = (k: string, v?: Record<string, string | number | Date>) => string;

function validate(days: Record<string, DayState>, t: HoursT): string | null {
  for (const day of DAY_ORDER) {
    const state = days[day];
    if (!state?.open) continue;
    if (state.windows.length === 0) {
      return t("invalidEmptyDay", { day: t(`days.${day}`) });
    }
    for (const w of state.windows) {
      if (w.start >= w.end) return t("invalidWindow", { day: t(`days.${day}`) });
    }
  }
  return null;
}

function useHoursSubmit(
  days: Record<string, DayState>,
  messages: { message: string; mediaMessage: string },
  th: HoursT,
) {
  const { message, mediaMessage } = messages;
  const t = useTranslations("settings");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onSubmit() {
    const error = validate(days, th);
    if (error) {
      toast.error(error);
      return;
    }
    startTransition(async () => {
      const result = await updateOrgSettingsAction({
        businessHours: toBusinessHours(days),
        offHoursMessage: message.trim() ? message.trim() : null,
        unsupportedMediaMessage: mediaMessage.trim() ? mediaMessage.trim() : null,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(t("hours.saved"));
      router.refresh();
    });
  }
  return { isPending, onSubmit };
}

function OffHoursCard({ message, onChange }: { message: string; onChange: (v: string) => void }) {
  const t = useTranslations("settings");
  return (
    <Card
      title={t("org.offHours")}
      subtitle={t("org.offHoursHint", { proximo_atendimento: "{proximo_atendimento}" })}
    >
      <Textarea
        value={message}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("org.offHoursPlaceholder", {
          proximo_atendimento: "{proximo_atendimento}",
        })}
      />
    </Card>
  );
}

function UnsupportedMediaCard({
  message,
  onChange,
}: {
  message: string;
  onChange: (v: string) => void;
}) {
  const t = useTranslations("settings");
  return (
    <Card title={t("org.unsupportedMedia")} subtitle={t("org.unsupportedMediaHint")}>
      <Textarea
        value={message}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("org.unsupportedMediaPlaceholder")}
      />
    </Card>
  );
}

export function HoursForm({
  businessHours,
  offHoursMessage,
  unsupportedMediaMessage,
  timezone,
}: {
  businessHours: BusinessHours | null;
  offHoursMessage: string | null;
  unsupportedMediaMessage: string | null;
  timezone: string;
}) {
  const t = useTranslations("settings");
  const th = useTranslations("settings.hours");
  const [days, setDays] = useState(() => toDayState(businessHours));
  const [message, setMessage] = useState(offHoursMessage ?? "");
  const [mediaMessage, setMediaMessage] = useState(unsupportedMediaMessage ?? "");
  const { isPending, onSubmit } = useHoursSubmit(days, { message, mediaMessage }, th);

  return (
    <div className="space-y-6" data-testid="hours-form">
      <Card title={th("weekly")} subtitle={th("weeklyHint", { timezone })}>
        <div className="divide-line-subtle divide-y">
          {DAY_ORDER.map((day) => (
            <DayRow
              key={day}
              day={day}
              state={days[day] ?? { open: false, windows: [] }}
              onChange={(next) => setDays((d) => ({ ...d, [day]: next }))}
            />
          ))}
        </div>
        <p className="text-ink-muted mt-3 text-xs">
          {th("timezoneReadonly")}{" "}
          <Link href="/app/settings/organization/general" className="underline">
            {th("timezoneLink")}
          </Link>
        </p>
      </Card>
      <OffHoursCard message={message} onChange={setMessage} />
      <UnsupportedMediaCard message={mediaMessage} onChange={setMediaMessage} />
      <div>
        <Button variant="primary" loading={isPending} onClick={onSubmit}>
          {t("org.submit")}
        </Button>
      </div>
    </div>
  );
}

"use client";

import { cn } from "@crm/design-system/lib/utils";
import { useTranslations } from "next-intl";

export type Mode = "reply" | "note";

export function ModeTabs({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const t = useTranslations("composer");
  const MODES = [
    { key: "reply", label: t("tabReply") },
    { key: "note", label: t("tabNote") },
  ] as const;
  return (
    <div className="flex gap-1" role="tablist" aria-label={t("tabsAria")}>
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          role="tab"
          aria-selected={mode === m.key}
          onClick={() => onChange(m.key)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            mode === m.key
              ? m.key === "note"
                ? "bg-warning/15 text-warning"
                : "bg-signal text-ink-on-signal"
              : "text-ink-muted hover:text-ink",
          )}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function ReplyChip({ preview, onClear }: { preview: string; onClear: () => void }) {
  const t = useTranslations("composer");
  return (
    <div
      className="bg-raised border-l-success flex items-center justify-between rounded-md border-l-4 px-3 py-1.5 text-xs"
      data-testid="reply-preview"
    >
      <span className="line-clamp-1 italic opacity-80">↩ {preview}</span>
      <button
        type="button"
        className="text-ink-muted hover:text-ink px-1"
        onClick={onClear}
        aria-label={t("cancelReply")}
      >
        ✕
      </button>
    </div>
  );
}

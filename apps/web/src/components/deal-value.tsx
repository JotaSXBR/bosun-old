"use client";

import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import type { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { formatValueCents } from "@/components/palette";
import { updateDealAction } from "@/server/actions/leads";

/** "1.234,56" → 123456 — pt-BR thousand groups or dot-decimal input. */
function parseValueCents(text: string): number | null {
  const parts = text.trim().split(",");
  if (parts.length > 2) return null;
  const [head = "", frac] = parts;
  // "1.234,56" or bare "1.234" — dots in \d{1,3}+\d{3}… shape are thousand
  // separators. "1234.56" (lone dot, no group shape) is a decimal mark.
  const groups = head.split(".");
  const grouped =
    groups.length > 1 &&
    /^\d{1,3}$/.test(groups[0] ?? "") &&
    groups.slice(1).every((g) => /^\d{3}$/.test(g));
  const numeric = `${grouped ? groups.join("") : head}${frac !== undefined ? `.${frac}` : ""}`;
  if (numeric === "" || Number.isNaN(Number(numeric))) return null;
  return Math.max(0, Math.round(Number(numeric) * 100));
}

function useDealValueEdit(dealId: string, valueCents: number) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

  const commit = () => {
    const cents = parseValueCents(draft);
    setEditing(false);
    if (cents === null || cents === valueCents) return;
    startTransition(async () => {
      const result = await updateDealAction({ dealId, valueCents: cents });
      if (!result.ok) toast.error(result.error);
      router.refresh();
    });
  };
  return { editing, setEditing, draft, setDraft, pending, commit };
}

function DealValueInput({
  draft,
  pending,
  label,
  onChange,
  onCommit,
  onCancel,
}: {
  draft: string;
  pending: boolean;
  label: string;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      inputMode="decimal"
      className="bg-page border-line w-24 rounded-xs border px-1 text-xs"
      value={draft}
      disabled={pending}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        if (e.key === "Escape") onCancel();
      }}
      aria-label={label}
    />
  );
}

/** Click-to-edit deal value — Enter/blur saves, Esc cancels. */
export function DealValue({
  dealId,
  valueCents,
  canWrite,
  t,
}: {
  dealId: string;
  valueCents: number;
  canWrite: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const { editing, setEditing, draft, setDraft, pending, commit } = useDealValueEdit(
    dealId,
    valueCents,
  );

  if (!canWrite) {
    return <>{valueCents > 0 && ` · ${formatValueCents(valueCents)}`}</>;
  }
  if (editing) {
    return (
      <DealValueInput
        draft={draft}
        pending={pending}
        label={t("panel.editValue")}
        onChange={setDraft}
        onCommit={commit}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <button
      type="button"
      className="underline decoration-dotted underline-offset-2"
      title={t("panel.editValue")}
      data-testid="deal-value"
      onClick={() => {
        setDraft(valueCents > 0 ? formatValueCents(valueCents).replace(/[^\d,.-]/g, "") : "");
        setEditing(true);
      }}
    >
      {" · "}
      {valueCents > 0 ? formatValueCents(valueCents) : t("panel.setValue")}
    </button>
  );
}

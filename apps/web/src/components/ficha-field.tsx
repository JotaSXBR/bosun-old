"use client";

import { toast } from "@crm/design-system/components/toast";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** The open editor of a ficha field: Enter/blur commits, Esc cancels. */
function FichaInput({
  multiline,
  label,
  draft,
  pending,
  onChange,
  onCommit,
  onCancel,
}: {
  multiline?: boolean;
  label: string;
  draft: string;
  pending: boolean;
  onChange: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const shared = {
    autoFocus: true,
    value: draft,
    disabled: pending,
    onBlur: onCommit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter" && !multiline) onCommit();
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
    "aria-label": label,
  };
  return multiline ? (
    <textarea
      {...shared}
      rows={3}
      className="bg-page border-line w-full rounded-xs border px-2 py-1 text-sm"
    />
  ) : (
    <input
      {...shared}
      className="bg-page border-line w-full rounded-xs border px-1.5 py-0.5 text-sm"
    />
  );
}

type SaveResult = { ok: true } | { ok: false; error: string };

function useFichaEdit(value: string, onSave: (next: string) => Promise<SaveResult>) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pending, startTransition] = useTransition();

  const commit = () => {
    setEditing(false);
    if (draft.trim() === value) return;
    startTransition(async () => {
      const result = await onSave(draft.trim());
      if (!result.ok) toast.error(result.error);
      router.refresh();
    });
  };
  return { editing, setEditing, draft, setDraft, pending, commit };
}

function FichaButton({
  label,
  value,
  placeholder,
  onClick,
}: {
  label: string;
  value: string;
  placeholder: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="text-ink hover:bg-raised -mx-1 block w-full rounded-xs px-1 text-left text-sm"
      title={label}
      onClick={onClick}
    >
      {value || <span className="text-ink-muted">{placeholder}</span>}
    </button>
  );
}

/** Click-to-edit text field — Enter/blur commits, Esc cancels. */
export function FichaField({
  label,
  value,
  placeholder,
  canWrite,
  onSave,
  multiline,
}: {
  label: string;
  value: string;
  placeholder: string;
  canWrite: boolean;
  onSave: (next: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  multiline?: boolean;
}) {
  const { editing, setEditing, draft, setDraft, pending, commit } = useFichaEdit(value, onSave);

  if (!canWrite) {
    return <span className="text-ink block text-sm">{value || "—"}</span>;
  }
  if (editing) {
    return (
      <FichaInput
        multiline={multiline}
        label={label}
        draft={draft}
        pending={pending}
        onChange={setDraft}
        onCommit={commit}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <FichaButton
      label={label}
      value={value}
      placeholder={placeholder}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    />
  );
}

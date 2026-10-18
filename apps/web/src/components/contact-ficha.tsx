"use client";

import type { UpdateContactProfileInput } from "@crm/core/contacts";
import type { LabelRow } from "@crm/core/leads";
import { Avatar } from "@crm/design-system/components/avatar";
import { Card } from "@crm/design-system/components/card";
import { toast } from "@crm/design-system/components/toast";
import { cn } from "@crm/design-system/lib/utils";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { LabelPicker } from "@/components/label-picker";
import { paletteStyle } from "@/components/palette";
// (palette lives in .ts — same specifier)
import { updateContactProfileAction } from "@/server/actions/contacts";
import { setContactLabelsAction, setConversationLabelsAction } from "@/server/actions/leads";

/** Click-to-edit text field — Enter/blur commits, Esc cancels. */
function FichaField({
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

  if (!canWrite) {
    return <span className="text-ink block text-sm">{value || "—"}</span>;
  }
  if (editing) {
    const shared = {
      autoFocus: true,
      value: draft,
      disabled: pending,
      onBlur: commit,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape") setEditing(false);
        if (e.key === "Enter" && !multiline) commit();
      },
      "aria-label": label,
    };
    return multiline ? (
      <textarea
        {...shared}
        rows={3}
        className="bg-page border-line w-full rounded-xs border px-2 py-1 text-sm"
        onChange={(e) => setDraft(e.target.value)}
      />
    ) : (
      <input
        {...shared}
        className="bg-page border-line w-full rounded-xs border px-1.5 py-0.5 text-sm"
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }
  return (
    <button
      type="button"
      className="text-ink hover:bg-raised -mx-1 block w-full rounded-xs px-1 text-left text-sm"
      title={label}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value || <span className="text-ink-muted">{placeholder}</span>}
    </button>
  );
}

type ProfileKey =
  "email" | "phone" | "company" | "jobTitle" | "birthday" | "address" | "urls" | "notes";

/** Profile fields in display order; `urls` is a list edited one per line. */
const PROFILE_FIELDS: { key: ProfileKey; multiline?: boolean; placeholder?: string }[] = [
  { key: "email" },
  { key: "phone" },
  { key: "company" },
  { key: "jobTitle" },
  { key: "birthday", placeholder: "birthdayPlaceholder" },
  { key: "address", multiline: true },
  { key: "urls", multiline: true, placeholder: "urlsPlaceholder" },
  { key: "notes", multiline: true },
];

function profileValue(metadata: Record<string, unknown>, key: ProfileKey): string {
  const v = metadata[key];
  if (Array.isArray(v)) return v.filter((u) => typeof u === "string").join("\n");
  return typeof v === "string" ? v : "";
}

function profilePatch(
  key: ProfileKey,
  value: string,
): Omit<UpdateContactProfileInput, "contactId"> {
  if (key === "urls") {
    return {
      urls: value
        .split("\n")
        .map((u) => u.trim())
        .filter(Boolean),
    };
  }
  return { [key]: value };
}

/**
 * Contact ficha (E2) — avatar, editable name/email/phone/notes, contact
 * tags and the conversation's etiquetas in one card (Google-People-style
 * inline edit, local only — no channel sync).
 */
export function ContactFicha({
  contactId,
  conversationId,
  displayName,
  channelUserId,
  avatarUrl,
  metadata,
  contactLabels,
  conversationLabels,
  allLabels,
  canWrite,
  canManageLabels,
}: {
  contactId: string;
  conversationId: string;
  displayName: string;
  channelUserId: string;
  avatarUrl: string | null;
  metadata: Record<string, unknown>;
  contactLabels: LabelRow[];
  conversationLabels: LabelRow[];
  allLabels: LabelRow[];
  canWrite: boolean;
  canManageLabels: boolean;
}) {
  const t = useTranslations("inbox.ficha");
  const tl = useTranslations("leads");

  const saveField = (patch: Omit<UpdateContactProfileInput, "contactId">) =>
    updateContactProfileAction({ contactId, ...patch });

  return (
    <Card bodyClassName="space-y-3 text-sm" title={t("title")} data-testid="contact-ficha">
      <div className="flex items-center gap-3">
        <Avatar src={avatarUrl ?? undefined} name={displayName || channelUserId} size="lg" />
        <div className="min-w-0 flex-1">
          <FichaField
            label={t("name")}
            value={displayName}
            placeholder={t("namePlaceholder")}
            canWrite={canWrite}
            onSave={(v) => saveField({ displayName: v || undefined })}
          />
          <p className="text-ink-muted truncate px-1 text-xs" title={channelUserId}>
            {channelUserId}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        {PROFILE_FIELDS.map(({ key, multiline, placeholder }) => (
          <div key={key}>
            <span className="text-ink-muted text-xs">{t(key)}</span>
            <FichaField
              label={t(key)}
              value={profileValue(metadata, key)}
              placeholder={t(placeholder ?? "add")}
              canWrite={canWrite}
              multiline={multiline}
              onSave={(v) => saveField(profilePatch(key, v))}
            />
          </div>
        ))}
      </div>

      <div className="border-line space-y-1.5 border-t pt-2">
        <span className="text-ink-muted text-xs">{t("contactTags")}</span>
        <div className="flex flex-wrap gap-1">
          {contactLabels.map((label) => (
            <span
              key={label.id}
              className={cn(
                "rounded-pill inline-flex h-6 items-center px-2.5 text-xs leading-none font-medium whitespace-nowrap",
                paletteStyle(label.color).chip,
              )}
            >
              {label.name}
            </span>
          ))}
          {contactLabels.length === 0 && (
            <span className="text-ink-muted text-xs">{tl("panel.noLabelsShort")}</span>
          )}
        </div>
        {canWrite && (
          <LabelPicker
            allLabels={allLabels}
            selectedIds={contactLabels.map((l) => l.id)}
            canCreate={canManageLabels}
            onSave={async (labelIds) => {
              const result = await setContactLabelsAction({ contactId, labelIds });
              return result.ok
                ? { ok: true }
                : { ok: false, error: "error" in result ? result.error : undefined };
            }}
          />
        )}
      </div>

      <div className="border-line space-y-1.5 border-t pt-2">
        <span className="text-ink-muted text-xs">{t("conversationLabels")}</span>
        <div className="flex flex-wrap gap-1">
          {conversationLabels.map((label) => (
            <span
              key={label.id}
              className={cn(
                "rounded-pill inline-flex h-6 items-center px-2.5 text-xs leading-none font-medium whitespace-nowrap",
                paletteStyle(label.color).chip,
              )}
            >
              {label.name}
            </span>
          ))}
          {conversationLabels.length === 0 && (
            <span className="text-ink-muted text-xs">{tl("panel.noLabelsShort")}</span>
          )}
        </div>
        {canWrite && (
          <LabelPicker
            allLabels={allLabels}
            selectedIds={conversationLabels.map((l) => l.id)}
            canCreate={canManageLabels}
            onSave={async (labelIds) => {
              const result = await setConversationLabelsAction({ conversationId, labelIds });
              return result.ok
                ? { ok: true }
                : { ok: false, error: "error" in result ? result.error : undefined };
            }}
          />
        )}
      </div>
    </Card>
  );
}

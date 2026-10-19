"use client";

import type { UpdateContactProfileInput } from "@crm/core/contacts";
import type { LabelRow } from "@crm/core/leads";
import { Avatar } from "@crm/design-system/components/avatar";
import { Card } from "@crm/design-system/components/card";
import { cn } from "@crm/design-system/lib/utils";
import { useTranslations } from "next-intl";

import { FichaField } from "@/components/ficha-field";
import { LabelPicker } from "@/components/label-picker";
import { paletteStyle } from "@/components/palette";
// (palette lives in .ts — same specifier)
import { updateContactProfileAction } from "@/server/actions/contacts";
import { setContactLabelsAction, setConversationLabelsAction } from "@/server/actions/leads";

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

type LabelSaveResult = { ok: true } | { ok: false; error?: string };

function LabelChips({ labels }: { labels: LabelRow[] }) {
  const tl = useTranslations("leads");
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
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
      {labels.length === 0 && (
        <span className="text-ink-muted text-xs">{tl("panel.noLabelsShort")}</span>
      )}
    </div>
  );
}

/** A titled chip list with an optional picker; `save` persists the picked label ids. */
function LabelSection({
  title,
  labels,
  allLabels,
  canWrite,
  canManageLabels,
  save,
}: {
  title: string;
  labels: LabelRow[];
  allLabels: LabelRow[];
  canWrite: boolean;
  canManageLabels: boolean;
  save: (labelIds: string[]) => Promise<LabelSaveResult>;
}) {
  return (
    <div className="border-line space-y-1.5 border-t pt-2">
      <span className="text-ink-muted text-xs">{title}</span>
      <LabelChips labels={labels} />
      {canWrite && (
        <LabelPicker
          allLabels={allLabels}
          selectedIds={labels.map((l) => l.id)}
          canCreate={canManageLabels}
          onSave={async (labelIds) => {
            const result = await save(labelIds);
            return result.ok
              ? { ok: true }
              : { ok: false, error: "error" in result ? result.error : undefined };
          }}
        />
      )}
    </div>
  );
}

type SaveField = (
  patch: Omit<UpdateContactProfileInput, "contactId">,
) => Promise<{ ok: true } | { ok: false; error: string }>;

function FichaHeader({
  displayName,
  channelUserId,
  avatarUrl,
  canWrite,
  saveField,
}: {
  displayName: string;
  channelUserId: string;
  avatarUrl: string | null;
  canWrite: boolean;
  saveField: SaveField;
}) {
  const t = useTranslations("inbox.ficha");
  return (
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
  );
}

function ProfileList({
  metadata,
  canWrite,
  saveField,
}: {
  metadata: Record<string, unknown>;
  canWrite: boolean;
  saveField: SaveField;
}) {
  const t = useTranslations("inbox.ficha");
  return (
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
  );
}

type ContactFichaProps = {
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
};

/**
 * Contact ficha (E2) — avatar, editable name/email/phone/notes, contact
 * tags and the conversation's etiquetas in one card (Google-People-style
 * inline edit, local only — no channel sync).
 */
export function ContactFicha(props: ContactFichaProps) {
  const t = useTranslations("inbox.ficha");
  const { contactId, conversationId, canWrite, canManageLabels, allLabels } = props;
  const saveField: SaveField = (patch) => updateContactProfileAction({ contactId, ...patch });

  return (
    <Card bodyClassName="space-y-3 text-sm" title={t("title")} data-testid="contact-ficha">
      <FichaHeader {...props} saveField={saveField} />
      <ProfileList metadata={props.metadata} canWrite={canWrite} saveField={saveField} />
      <LabelSection
        title={t("contactTags")}
        labels={props.contactLabels}
        allLabels={allLabels}
        canWrite={canWrite}
        canManageLabels={canManageLabels}
        save={(labelIds) => setContactLabelsAction({ contactId, labelIds })}
      />
      <LabelSection
        title={t("conversationLabels")}
        labels={props.conversationLabels}
        allLabels={allLabels}
        canWrite={canWrite}
        canManageLabels={canManageLabels}
        save={(labelIds) => setConversationLabelsAction({ conversationId, labelIds })}
      />
    </Card>
  );
}

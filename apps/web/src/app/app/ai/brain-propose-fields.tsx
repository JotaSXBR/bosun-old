"use client";

import type { MemoryConfidence, MemoryEntryType, MemoryScope } from "@crm/core/brain";
import { Input } from "@crm/design-system/components/input";
import { Label } from "@crm/design-system/components/label";
import { Select } from "@crm/design-system/components/select";
import { Textarea } from "@crm/design-system/components/textarea";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { searchContactsAction } from "@/server/actions/leads";
import type { ContactPickRow } from "@/server/services";

const TYPES: MemoryEntryType[] = [
  "pattern",
  "procedure",
  "faq_gap",
  "decision",
  "preference",
  "escalation",
  "persona",
  "metric",
];
const TYPE_LABEL: Record<MemoryEntryType, string> = {
  pattern: "typePattern",
  procedure: "typeProcedure",
  faq_gap: "typeFaqGap",
  decision: "typeDecision",
  preference: "typePreference",
  escalation: "typeEscalation",
  persona: "typePersona",
  metric: "typeMetric",
};

export type ProposeForm = {
  type: MemoryEntryType;
  scope: MemoryScope;
  teamId: string;
  contactId: string;
  content: string;
  confidence: MemoryConfidence;
  staleAfterDays: number;
  rationale: string;
};

export const emptyProposeForm: ProposeForm = {
  type: "pattern",
  scope: "org",
  teamId: "",
  contactId: "",
  content: "",
  confidence: "medium",
  staleAfterDays: 90,
  rationale: "",
};

function ContactPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("settings.ai.brain");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<ContactPickRow[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void searchContactsAction(query || undefined).then((r) => {
        if (r.ok) setContacts(r.data);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("searchContact")}
        aria-label={t("searchContact")}
        disabled={disabled}
      />
      <Select
        options={contacts.map((c) => ({ value: c.id, label: c.displayName ?? c.channelUserId }))}
        value={value || undefined}
        onChange={onChange}
        placeholder={t("selectContact")}
        aria-label={t("contact")}
        disabled={disabled}
      />
      {contacts.length === 0 && <p className="text-ink-muted text-xs">{t("noContacts")}</p>}
    </div>
  );
}

type FieldsProps = {
  form: ProposeForm;
  set: <K extends keyof ProposeForm>(key: K, value: ProposeForm[K]) => void;
  pending: boolean;
};

function TypeScopeRow({ form, set, pending }: FieldsProps) {
  const t = useTranslations("settings.ai.brain");
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label>{t("type")}</Label>
        <Select
          options={TYPES.map((type) => ({ value: type, label: t(TYPE_LABEL[type]) }))}
          value={form.type}
          onChange={(v) => set("type", v as MemoryEntryType)}
          disabled={pending}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("scope")}</Label>
        <Select
          options={[
            { value: "org", label: t("scopeOrg") },
            { value: "team", label: t("scopeTeam") },
            { value: "contact", label: t("scopeContact") },
          ]}
          value={form.scope}
          onChange={(v) => set("scope", v as MemoryScope)}
          disabled={pending}
        />
      </div>
    </div>
  );
}

function ScopeTarget({
  form,
  set,
  teams,
  pending,
}: FieldsProps & { teams: Array<{ id: string; name: string }> }) {
  const t = useTranslations("settings.ai.brain");
  if (form.scope === "team") {
    return (
      <div className="space-y-1">
        <Label>{t("team")}</Label>
        <Select
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          value={form.teamId || undefined}
          onChange={(v) => set("teamId", v)}
          placeholder={t("team")}
          disabled={pending}
        />
      </div>
    );
  }
  if (form.scope === "contact") {
    return (
      <div className="space-y-1">
        <Label>{t("contact")}</Label>
        <ContactPicker
          value={form.contactId}
          onChange={(id) => set("contactId", id)}
          disabled={pending}
        />
      </div>
    );
  }
  return null;
}

function ContentField({ form, set, pending }: FieldsProps) {
  const t = useTranslations("settings.ai.brain");
  return (
    <div className="space-y-1">
      <Label htmlFor="brain-content">{t("content")}</Label>
      <Textarea
        id="brain-content"
        value={form.content}
        onChange={(e) => set("content", e.target.value)}
        rows={3}
        maxLength={2000}
        disabled={pending}
      />
      <p className="text-ink-muted text-xs">{t("contentHint")}</p>
    </div>
  );
}

function ConfidenceStaleRow({ form, set, pending }: FieldsProps) {
  const t = useTranslations("settings.ai.brain");
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1">
        <Label>{t("confidence")}</Label>
        <Select
          options={[
            { value: "low", label: t("confidenceLow") },
            { value: "medium", label: t("confidenceMedium") },
            { value: "high", label: t("confidenceHigh") },
          ]}
          value={form.confidence}
          onChange={(v) => set("confidence", v as MemoryConfidence)}
          disabled={pending}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="brain-stale">{t("staleAfterDays")}</Label>
        <Input
          shape="rounded"
          id="brain-stale"
          type="number"
          min={1}
          max={730}
          value={form.staleAfterDays}
          onChange={(e) => set("staleAfterDays", Number(e.target.value) || 90)}
          disabled={pending}
        />
        <p className="text-ink-muted text-xs">{t("staleAfterHint")}</p>
      </div>
    </div>
  );
}

function RationaleField({ form, set, pending }: FieldsProps) {
  const t = useTranslations("settings.ai.brain");
  return (
    <div className="space-y-1">
      <Label htmlFor="brain-rationale">{t("rationale")}</Label>
      <Textarea
        id="brain-rationale"
        value={form.rationale}
        onChange={(e) => set("rationale", e.target.value)}
        rows={2}
        maxLength={4000}
        disabled={pending}
      />
      <p className="text-ink-muted text-xs">{t("rationaleHint")}</p>
    </div>
  );
}

export function ProposeFields({
  teams,
  ...fields
}: FieldsProps & { teams: Array<{ id: string; name: string }> }) {
  return (
    <div className="space-y-3">
      <TypeScopeRow {...fields} />
      <ScopeTarget teams={teams} {...fields} />
      <ContentField {...fields} />
      <ConfidenceStaleRow {...fields} />
      <RationaleField {...fields} />
    </div>
  );
}

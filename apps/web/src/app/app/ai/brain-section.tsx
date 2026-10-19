"use client";

import type { MemoryEntryRow } from "@crm/core/brain";
import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { useRunAction } from "@/lib/use-run-action";
import {
  archiveBrainEntryAction,
  proposeMemoryEntryAction,
  renewBrainEntryAction,
} from "@/server/actions/ai";

import type { ProposeForm } from "./brain-propose-dialog";
import { BrainProposeDialog, emptyProposeForm } from "./brain-propose-dialog";

const TYPE_LABEL: Record<string, string> = {
  pattern: "typePattern",
  procedure: "typeProcedure",
  faq_gap: "typeFaqGap",
  decision: "typeDecision",
  preference: "typePreference",
  escalation: "typeEscalation",
  persona: "typePersona",
  metric: "typeMetric",
};

const SCOPE_LABEL: Record<string, string> = {
  org: "scopeOrg",
  team: "scopeTeam",
  contact: "scopeContact",
};

function formatDate(date: Date | string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("pt-BR");
}

type TeamOption = { id: string; name: string };

function toProposeInput(form: ProposeForm) {
  return {
    type: form.type,
    scope: form.scope,
    teamId: form.scope === "team" ? form.teamId : null,
    contactId: form.scope === "contact" ? form.contactId : null,
    content: form.content.trim(),
    confidence: form.confidence,
    staleAfterDays: form.staleAfterDays,
    rationale: form.rationale.trim(),
  };
}

function EntryActions({
  entry,
  stale,
  pending,
  run,
}: {
  entry: MemoryEntryRow;
  stale: boolean;
  pending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.ai.brain");
  return (
    <div className="flex shrink-0 items-center gap-2">
      {stale && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run(renewBrainEntryAction({ entryId: entry.id, staleAfterDays: 90 }), t("verified"))
          }
        >
          {t("verify")}
        </Button>
      )}
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => {
          if (window.confirm(t("archiveConfirm"))) {
            run(archiveBrainEntryAction(entry.id), t("archived"));
          }
        }}
      >
        {t("archive")}
      </Button>
    </div>
  );
}

function EntryRow({
  entry,
  stale,
  canManage,
  pending,
  run,
}: {
  entry: MemoryEntryRow;
  stale: boolean;
  canManage: boolean;
  pending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.ai.brain");
  return (
    <li className="space-y-1 border-b pb-2 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone="neutral">{t(TYPE_LABEL[entry.type] ?? "typePattern")}</Badge>
          <Badge tone="neutral">{t(SCOPE_LABEL[entry.scope] ?? "scopeOrg")}</Badge>
          <Badge tone="neutral">
            {t(
              `confidence${entry.confidence === "high" ? "High" : entry.confidence === "low" ? "Low" : "Medium"}`,
            )}
          </Badge>
          <span className="text-ink-muted text-xs">
            {t("validUntil", { date: formatDate(entry.staleAfter) })}
          </span>
        </div>
        {canManage && <EntryActions entry={entry} stale={stale} pending={pending} run={run} />}
      </div>
      <p className="text-sm">{entry.content}</p>
    </li>
  );
}

function EntryLists({
  entries,
  stale,
  canManage,
  pending,
  run,
}: {
  entries: MemoryEntryRow[];
  stale: MemoryEntryRow[];
  canManage: boolean;
  pending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.ai.brain");
  const row = (entry: MemoryEntryRow, isStale: boolean) => (
    <EntryRow
      key={entry.id}
      entry={entry}
      stale={isStale}
      canManage={canManage}
      pending={pending}
      run={run}
    />
  );
  return (
    <>
      {stale.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase">{t("staleTitle")}</p>
          <p className="text-ink-muted text-xs">{t("staleDescription")}</p>
          <ul className="space-y-2" data-testid="brain-stale-list">
            {stale.map((entry) => row(entry, true))}
          </ul>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="text-ink-muted text-sm" data-testid="brain-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="brain-list">
          {entries.map((entry) => row(entry, false))}
        </ul>
      )}
    </>
  );
}

type BrainSectionProps = {
  entries: MemoryEntryRow[];
  stale: MemoryEntryRow[];
  teams: TeamOption[];
  canManage: boolean;
  /** §7.4 — "Propor memória" is owner/admin only; curation stays ai:manage. */
  canPropose: boolean;
};

export function BrainSection({ entries, stale, teams, canManage, canPropose }: BrainSectionProps) {
  const t = useTranslations("settings.ai.brain");
  const { pending, run } = useRunAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProposeForm>(emptyProposeForm);

  const submit = () =>
    run(proposeMemoryEntryAction(toProposeInput(form)), t("proposed"), () => {
      setOpen(false);
      setForm(emptyProposeForm);
    });

  return (
    <Card bodyClassName="space-y-4" title={t("title")} subtitle={t("description")}>
      <>
        <EntryLists
          entries={entries}
          stale={stale}
          canManage={canManage}
          pending={pending}
          run={run}
        />
        {canPropose && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setForm(emptyProposeForm);
              setOpen(true);
            }}
            disabled={pending}
          >
            {t("new")}
          </Button>
        )}
      </>

      <BrainProposeDialog
        open={open}
        onOpenChange={setOpen}
        teams={teams}
        form={form}
        setForm={setForm}
        pending={pending}
        onSubmit={submit}
      />
    </Card>
  );
}

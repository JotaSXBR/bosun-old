"use client";

import type { AgentRow } from "@crm/core/agents";
import type { KnowledgeEntryRow } from "@crm/core/knowledge";
import type { AgentSuggestionRow } from "@crm/core/suggestions";
import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { useTranslations } from "next-intl";

import type { RunAction } from "@/lib/use-run-action";
import { useRunAction } from "@/lib/use-run-action";
import { approveSuggestionAction, rejectSuggestionAction } from "@/server/actions/ai";

type T = ReturnType<typeof useTranslations>;

const targetLabel = (s: AgentSuggestionRow, t: T): string =>
  s.targetType === "agent"
    ? t("targetAgent")
    : s.targetType === "memory"
      ? t("targetMemory")
      : t("targetKnowledge");

function targetName(
  s: AgentSuggestionRow,
  lookup: { agents: AgentRow[]; knowledge: KnowledgeEntryRow[] },
  t: T,
): string {
  if (s.targetType === "memory") {
    const content = (s.payload as { content?: string }).content ?? "";
    return content.length > 80 ? `${content.slice(0, 80)}…` : content;
  }
  if (!s.targetId) return t("targetNew");
  if (s.targetType === "agent") {
    return lookup.agents.find((a) => a.id === s.targetId)?.name ?? s.targetId;
  }
  return lookup.knowledge.find((k) => k.id === s.targetId)?.title ?? s.targetId;
}

function PendingSuggestion({
  suggestion: s,
  name,
  canDecide,
  pending,
  run,
}: {
  suggestion: AgentSuggestionRow;
  name: string;
  canDecide: boolean;
  pending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.ai.suggestions");
  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm">
        <Badge tone="neutral">{targetLabel(s, t)}</Badge>
        <span className="font-medium">{name}</span>
      </div>
      <p className="text-sm">{s.rationale}</p>
      <details className="text-ink-muted text-xs">
        <summary>{t("fields", { fields: Object.keys(s.payload as object).join(", ") })}</summary>
        <pre className="bg-raised mt-1 overflow-x-auto rounded-xs p-2">
          {JSON.stringify(s.payload, null, 2)}
        </pre>
      </details>
      {canDecide && (
        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={pending}
            onClick={() => run(approveSuggestionAction(s.id), t("approved"))}
          >
            {t("approve")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => run(rejectSuggestionAction(s.id), t("rejected"))}
          >
            {t("reject")}
          </Button>
        </div>
      )}
    </li>
  );
}

function ReviewedHistory({
  reviewed,
  nameOf,
}: {
  reviewed: AgentSuggestionRow[];
  nameOf: (s: AgentSuggestionRow) => string;
}) {
  const t = useTranslations("settings.ai.suggestions");
  if (reviewed.length === 0) return null;
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-ink-muted text-xs font-medium uppercase">{t("history")}</p>
      <ul className="space-y-1" data-testid="suggestion-history">
        {reviewed.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-sm">
            <Badge tone="neutral">
              {s.status === "approved" ? t("statusApproved") : t("statusRejected")}
            </Badge>
            <span className="text-ink-muted">
              {targetLabel(s, t)} · {nameOf(s)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SuggestionsSection({
  suggestions,
  agents,
  knowledge,
  canManage,
  canReviewMemory,
}: {
  suggestions: AgentSuggestionRow[];
  agents: AgentRow[];
  knowledge: KnowledgeEntryRow[];
  canManage: boolean;
  /** §7.4 — memory proposals are decided only by owner/admin. */
  canReviewMemory: boolean;
}) {
  const t = useTranslations("settings.ai.suggestions");
  const { pending, run } = useRunAction();
  const nameOf = (s: AgentSuggestionRow) => targetName(s, { agents, knowledge }, t);

  const pendingList = suggestions.filter((s) => s.status === "pending");
  const reviewed = suggestions.filter((s) => s.status !== "pending");

  return (
    <Card bodyClassName="space-y-4" title={t("title")} subtitle={t("description")}>
      {pendingList.length === 0 ? (
        <p className="text-ink-muted text-sm" data-testid="suggestions-empty">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-3" data-testid="suggestion-list">
          {pendingList.map((s) => (
            <PendingSuggestion
              key={s.id}
              suggestion={s}
              name={nameOf(s)}
              canDecide={canManage && (s.targetType !== "memory" || canReviewMemory)}
              pending={pending}
              run={run}
            />
          ))}
        </ul>
      )}

      <ReviewedHistory reviewed={reviewed} nameOf={nameOf} />
    </Card>
  );
}

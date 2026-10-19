"use client";

import type { MacroRow } from "@crm/core/macros";
import type { AgentSuggestionRow } from "@crm/core/suggestions";
import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { Input } from "@crm/design-system/components/input";
import { Textarea } from "@crm/design-system/components/textarea";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { useRunAction } from "@/lib/use-run-action";
import {
  approveMacroAction,
  deleteMacroAction,
  rejectMacroAction,
  updateMacroAction,
} from "@/server/actions/macros";

import { NewMacroCard } from "./new-macro-card";

/** Inline-edit state of the macro list: which row is open and its draft fields. */
function useMacroEdit() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const startEdit = (m: MacroRow) => {
    setEditingId(m.id);
    setEditName(m.name);
    setEditContent(m.content);
  };
  return { editingId, setEditingId, editName, setEditName, editContent, setEditContent, startEdit };
}

type Edit = ReturnType<typeof useMacroEdit>;

function MacroEditForm({
  macro,
  edit,
  isPending,
  run,
}: {
  macro: MacroRow;
  edit: Edit;
  isPending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.macros");
  const { editName, setEditName, editContent, setEditContent, setEditingId } = edit;
  return (
    <div className="space-y-2">
      <Input shape="rounded" value={editName} onChange={(e) => setEditName(e.target.value)} />
      <Textarea rows={3} value={editContent} onChange={(e) => setEditContent(e.target.value)} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={isPending}
          onClick={() =>
            run(
              updateMacroAction(macro.id, {
                name: editName.trim().replace(/^\/+/, ""),
                content: editContent.trim(),
              }),
              t("saved"),
              () => setEditingId(null),
            )
          }
        >
          {t("save")}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

function MacroView({
  macro,
  canWrite,
  isPending,
  onEdit,
  run,
}: {
  macro: MacroRow;
  canWrite: boolean;
  isPending: boolean;
  onEdit: () => void;
  run: RunAction;
}) {
  const t = useTranslations("settings.macros");
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">/{macro.name}</p>
        <p className="text-ink-muted mt-1 line-clamp-2 text-sm">{macro.content}</p>
      </div>
      {canWrite && (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            {t("edit")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={isPending}
            onClick={() => run(deleteMacroAction(macro.id), t("deleted"))}
          >
            {t("delete")}
          </Button>
        </div>
      )}
    </div>
  );
}

function MacroList({
  macros,
  canWrite,
  isPending,
  run,
}: {
  macros: MacroRow[];
  canWrite: boolean;
  isPending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.macros");
  const edit = useMacroEdit();
  return (
    <Card title={t("listTitle")} bodyClassName="space-y-3">
      {macros.length === 0 ? (
        <p className="text-ink-muted text-sm">{t("empty")}</p>
      ) : (
        <ul className="space-y-2" data-testid="macro-list">
          {macros.map((m) => (
            <li key={m.id} className="border-line rounded-md border p-3">
              {edit.editingId === m.id ? (
                <MacroEditForm macro={m} edit={edit} isPending={isPending} run={run} />
              ) : (
                <MacroView
                  macro={m}
                  canWrite={canWrite}
                  isPending={isPending}
                  onEdit={() => edit.startEdit(m)}
                  run={run}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PendingProposal({
  suggestion: s,
  currentUserId,
  isPending,
  run,
}: {
  suggestion: AgentSuggestionRow;
  currentUserId: string;
  isPending: boolean;
  run: RunAction;
}) {
  const t = useTranslations("settings.macros");
  const payload = s.payload as { name?: string; content?: string };
  const isOwn = s.proposedBy === currentUserId;
  return (
    <li className="border-line rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm">
        <Badge tone="neutral">/{payload.name ?? "?"}</Badge>
        {isOwn && <Badge tone="accent">{t("ownProposal")}</Badge>}
      </div>
      <p className="text-ink-muted mt-1 text-sm">{payload.content ?? ""}</p>
      <p className="text-ink-muted mt-1 text-xs italic">{s.rationale}</p>
      <div className="mt-2 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={isPending || isOwn}
          onClick={() => run(approveMacroAction(s.id), t("approved"))}
        >
          {t("approve")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={isPending}
          onClick={() => run(rejectMacroAction(s.id), t("rejected"))}
        >
          {t("reject")}
        </Button>
      </div>
    </li>
  );
}

type MacrosManagerProps = {
  macros: MacroRow[];
  pending: AgentSuggestionRow[];
  canWrite: boolean;
  canReview: boolean;
  canPropose: boolean;
  currentUserId: string;
};

export function MacrosManager(props: MacrosManagerProps) {
  const { macros, pending, canWrite, canReview, canPropose, currentUserId } = props;
  const t = useTranslations("settings.macros");
  const { pending: isPending, run } = useRunAction();

  return (
    <div className="space-y-4">
      {canPropose && <NewMacroCard canWrite={canWrite} isPending={isPending} run={run} />}
      <MacroList macros={macros} canWrite={canWrite} isPending={isPending} run={run} />
      {canReview && pending.length > 0 && (
        <Card title={t("pendingTitle")} subtitle={t("pendingSubtitle")} bodyClassName="space-y-3">
          <ul className="space-y-2" data-testid="macro-pending-list">
            {pending.map((s) => (
              <PendingProposal
                key={s.id}
                suggestion={s}
                currentUserId={currentUserId}
                isPending={isPending}
                run={run}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

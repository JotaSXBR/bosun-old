"use client";

import type { KnowledgeEntryRow } from "@crm/core/knowledge";
import { Badge } from "@crm/design-system/components/badge";
import { Button } from "@crm/design-system/components/button";
import { Card } from "@crm/design-system/components/card";
import { useTranslations } from "next-intl";
import { useState } from "react";

import type { RunAction } from "@/lib/use-run-action";
import { useRunAction } from "@/lib/use-run-action";
import {
  createKnowledgeEntryAction,
  deleteKnowledgeEntryAction,
  updateKnowledgeEntryAction,
} from "@/server/actions/ai";

import { KnowledgeFormDialog } from "./knowledge-form-dialog";

/** Dialog draft: which entry is being edited (if any) and its fields. */
function useKnowledgeDraft() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeEntryRow | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");

  const openCreate = () => {
    setEditing(null);
    setTitle("");
    setContent("");
    setStatus("active");
    setOpen(true);
  };
  const openEdit = (entry: KnowledgeEntryRow) => {
    setEditing(entry);
    setTitle(entry.title);
    setContent(entry.content);
    setStatus(entry.status === "archived" ? "archived" : "active");
    setOpen(true);
  };
  return {
    open,
    setOpen,
    editing,
    title,
    setTitle,
    content,
    setContent,
    status,
    setStatus,
    openCreate,
    openEdit,
  };
}

function KnowledgeRow({
  entry,
  canManage,
  pending,
  run,
  onEdit,
}: {
  entry: KnowledgeEntryRow;
  canManage: boolean;
  pending: boolean;
  run: RunAction;
  onEdit: () => void;
}) {
  const t = useTranslations("settings.ai.knowledge");
  return (
    <li className="flex items-center justify-between gap-3 border-b pb-2 last:border-0">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{entry.title}</span>
        <Badge tone="neutral">
          {entry.status === "archived" ? t("statusArchived") : t("statusActive")}
        </Badge>
        <Badge tone="neutral">
          {entry.source === "suggestion" ? t("sourceSuggestion") : t("sourceManual")}
        </Badge>
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" disabled={pending} onClick={onEdit}>
            {t("edit")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(t("deleteConfirm", { title: entry.title }))) {
                run(deleteKnowledgeEntryAction(entry.id), t("deleted"));
              }
            }}
          >
            {t("delete")}
          </Button>
        </div>
      )}
    </li>
  );
}

function KnowledgeList({
  entries,
  canManage,
  pending,
  run,
  onEdit,
}: {
  entries: KnowledgeEntryRow[];
  canManage: boolean;
  pending: boolean;
  run: RunAction;
  onEdit: (entry: KnowledgeEntryRow) => void;
}) {
  const t = useTranslations("settings.ai.knowledge");
  if (entries.length === 0) {
    return (
      <p className="text-ink-muted text-sm" data-testid="knowledge-empty">
        {t("empty")}
      </p>
    );
  }
  return (
    <ul className="space-y-2" data-testid="knowledge-list">
      {entries.map((entry) => (
        <KnowledgeRow
          key={entry.id}
          entry={entry}
          canManage={canManage}
          pending={pending}
          run={run}
          onEdit={() => onEdit(entry)}
        />
      ))}
    </ul>
  );
}

export function KnowledgeSection({
  entries,
  canManage,
}: {
  entries: KnowledgeEntryRow[];
  canManage: boolean;
}) {
  const t = useTranslations("settings.ai.knowledge");
  const { pending, run } = useRunAction();
  const draft = useKnowledgeDraft();
  const { setOpen, editing, title, content, status } = draft;

  const submit = () => {
    const values = { title: title.trim(), content: content.trim(), status };
    const request = editing
      ? updateKnowledgeEntryAction({ entryId: editing.id, ...values })
      : createKnowledgeEntryAction(values);
    run(request, editing ? t("saved") : t("created"), () => setOpen(false));
  };

  return (
    <Card bodyClassName="space-y-3" title={t("title")} subtitle={t("description")}>
      <>
        <KnowledgeList
          entries={entries}
          canManage={canManage}
          pending={pending}
          run={run}
          onEdit={draft.openEdit}
        />
        {canManage && (
          <Button size="sm" variant="secondary" onClick={draft.openCreate} disabled={pending}>
            {t("new")}
          </Button>
        )}
      </>

      <KnowledgeFormDialog
        open={draft.open}
        onOpenChange={setOpen}
        editing={editing !== null}
        title={title}
        setTitle={draft.setTitle}
        content={content}
        setContent={draft.setContent}
        status={status}
        setStatus={draft.setStatus}
        pending={pending}
        onSubmit={submit}
      />
    </Card>
  );
}

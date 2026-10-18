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

import { useRunAction } from "@/lib/use-run-action";
import {
  approveMacroAction,
  createMacroAction,
  deleteMacroAction,
  proposeMacroAction,
  rejectMacroAction,
  updateMacroAction,
} from "@/server/actions/macros";

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

export function MacrosManager({
  macros,
  pending,
  canWrite,
  canReview,
  canPropose,
  currentUserId,
}: {
  macros: MacroRow[];
  pending: AgentSuggestionRow[];
  canWrite: boolean;
  canReview: boolean;
  canPropose: boolean;
  currentUserId: string;
}) {
  const t = useTranslations("settings.macros");
  const { pending: isPending, run } = useRunAction();
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [rationale, setRationale] = useState("");
  const { editingId, setEditingId, editName, setEditName, editContent, setEditContent, startEdit } =
    useMacroEdit();

  const submitNew = () => {
    const trimmedName = name.trim().replace(/^\/+/, "");
    const trimmedContent = content.trim();
    if (!trimmedName || !trimmedContent) return;
    if (canWrite) {
      run(createMacroAction({ name: trimmedName, content: trimmedContent }), t("created"), () => {
        setName("");
        setContent("");
      });
    } else {
      const trimmedRationale = rationale.trim();
      if (!trimmedRationale) return;
      run(
        proposeMacroAction({
          name: trimmedName,
          content: trimmedContent,
          rationale: trimmedRationale,
        }),
        t("proposed"),
        () => {
          setName("");
          setContent("");
          setRationale("");
        },
      );
    }
  };

  return (
    <div className="space-y-4">
      {canPropose && (
        <Card title={canWrite ? t("newTitle") : t("proposeTitle")} subtitle={t("newSubtitle")}>
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="macro-name" className="text-sm font-medium">
                {t("name")}
              </label>
              <Input
                id="macro-name"
                shape="rounded"
                value={name}
                placeholder={t("namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="macro-content" className="text-sm font-medium">
                {t("content")}
              </label>
              <Textarea
                id="macro-content"
                rows={3}
                value={content}
                placeholder={t("contentPlaceholder")}
                onChange={(e) => setContent(e.target.value)}
              />
            </div>
            {!canWrite && (
              <div className="space-y-1">
                <label htmlFor="macro-rationale" className="text-sm font-medium">
                  {t("rationale")}
                </label>
                <Input
                  id="macro-rationale"
                  shape="rounded"
                  value={rationale}
                  placeholder={t("rationalePlaceholder")}
                  onChange={(e) => setRationale(e.target.value)}
                />
              </div>
            )}
            <Button variant="primary" size="sm" disabled={isPending} onClick={submitNew}>
              {canWrite ? t("create") : t("propose")}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t("listTitle")} bodyClassName="space-y-3">
        {macros.length === 0 ? (
          <p className="text-ink-muted text-sm">{t("empty")}</p>
        ) : (
          <ul className="space-y-2" data-testid="macro-list">
            {macros.map((m) => (
              <li key={m.id} className="border-line rounded-md border p-3">
                {editingId === m.id ? (
                  <div className="space-y-2">
                    <Input
                      shape="rounded"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                    <Textarea
                      rows={3}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={isPending}
                        onClick={() =>
                          run(
                            updateMacroAction(m.id, {
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
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">/{m.name}</p>
                      <p className="text-ink-muted mt-1 line-clamp-2 text-sm">{m.content}</p>
                    </div>
                    {canWrite && (
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="secondary" onClick={() => startEdit(m)}>
                          {t("edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={isPending}
                          onClick={() => run(deleteMacroAction(m.id), t("deleted"))}
                        >
                          {t("delete")}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canReview && pending.length > 0 && (
        <Card title={t("pendingTitle")} subtitle={t("pendingSubtitle")} bodyClassName="space-y-3">
          <ul className="space-y-2" data-testid="macro-pending-list">
            {pending.map((s) => {
              const payload = s.payload as { name?: string; content?: string };
              const isOwn = s.proposedBy === currentUserId;
              return (
                <li key={s.id} className="border-line rounded-md border p-3">
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
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

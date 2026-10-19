"use client";

// Interactive islands inside the (server-rendered) message thread: the
// edited-history and "ver original" expanders and the failed-send retry. The
// per-message menus live in ./message-menu and ./message-context-menu.
// Mutations are server actions → router.refresh().
import { cn } from "@crm/design-system/lib/utils";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import type { TargetProps } from "@/components/message-menu";
import { useAction } from "@/lib/use-action";
import {
  getMessageOriginalAction,
  listMessageEditsAction,
  resendMessageAction,
} from "@/server/actions/chat";

type EditEntry = { previousText: string | null; createdAt: string };

/** Lazily loads the edit history on first expand; `toggle` ignores non-inspectors. */
function useEditHistory({
  conversationId,
  messageId,
  canInspect,
}: TargetProps & { canInspect: boolean }) {
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<EditEntry[] | null>(null);
  const { pending, run } = useAction();

  const toggle = () => {
    if (!canInspect) return;
    if (!open && edits === null) {
      run(async () => {
        const r = await listMessageEditsAction({ conversationId, messageId });
        if (r.ok) {
          setEdits(r.edits);
          setOpen(true);
        }
        return r;
      });
      return;
    }
    setOpen((v) => !v);
  };
  return { open, edits, pending, toggle };
}

function EditHistoryList({ edits }: { edits: EditEntry[] }) {
  const t = useTranslations("message");
  const format = useFormatter();
  return (
    <span className="block text-left" data-testid="edit-history">
      {edits.length === 0 && <span className="block">{t("noEdits")}</span>}
      {edits.map((e) => (
        <span key={e.createdAt} className="block italic">
          “{e.previousText ?? t("mediaPlaceholder")}” ·{" "}
          {format.dateTime(new Date(e.createdAt), {
            dateStyle: "short",
            timeStyle: "medium",
          })}
        </span>
      ))}
    </span>
  );
}

/** "(editada)" — privileged roles can expand the previous versions. */
export function EditedIndicator(props: TargetProps & { canInspect: boolean }) {
  const { canInspect } = props;
  const t = useTranslations("message");
  const { open, edits, pending, toggle } = useEditHistory(props);

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        disabled={pending || !canInspect}
        className={cn("italic", canInspect && "hover:underline")}
        title={canInspect ? t("viewEdits") : undefined}
      >
        {t("edited")}
      </button>
      {open && edits && <EditHistoryList edits={edits} />}
    </>
  );
}

/** Failed outbound bubble — retries the send in place (no duplicate row). */
export function ResendButton({ conversationId, messageId }: TargetProps) {
  const t = useTranslations("message");
  const { pending, run } = useAction();
  return (
    <button
      type="button"
      className="underline underline-offset-2 disabled:opacity-60"
      disabled={pending}
      data-testid="resend-message"
      onClick={() => run(() => resendMessageAction({ conversationId, messageId }))}
    >
      {pending ? t("resending") : t("resend")}
    </button>
  );
}

/** Revoked placeholder extra — privileged roles may reveal the original. */
export function RevokedActions({ conversationId, messageId }: TargetProps) {
  const t = useTranslations("message");
  const [original, setOriginal] = useState<string | null>(null);
  const { pending, run } = useAction();
  return (
    <span className="block" data-testid="revoked-actions">
      <button
        type="button"
        className="text-xs underline"
        disabled={pending}
        onClick={() => {
          if (original !== null) {
            setOriginal(null);
            return;
          }
          run(async () => {
            const r = await getMessageOriginalAction({ conversationId, messageId });
            if (r.ok) setOriginal(r.text ?? t("mediaPlaceholder"));
            return r;
          });
        }}
      >
        {original === null ? t("viewOriginal") : t("hide")}
      </button>
      {original !== null && (
        <span className="mt-1 block rounded-xs border border-dashed p-2 text-xs whitespace-pre-wrap">
          {original}
        </span>
      )}
    </span>
  );
}

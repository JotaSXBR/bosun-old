"use client";

// Interactive islands inside the (server-rendered) message thread:
// per-message menu (react/reply/edit/delete), edited-history and
// "ver original" expanders. Mutations are server actions → router.refresh().
import { cn } from "@crm/design-system/lib/utils";
import { useFormatter, useTranslations } from "next-intl";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { setReplyTarget } from "@/lib/reply-bridge";
import { useAction } from "@/lib/use-action";
import {
  deleteMessageAction,
  editMessageAction,
  getMessageOriginalAction,
  listMessageEditsAction,
  reactToMessageAction,
  resendMessageAction,
} from "@/server/actions/chat";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

type TargetProps = { conversationId: string; messageId: string };

/** Edit / delete-confirm / draft-text state shared by both menu flavors. */
function useMessageMenuState(currentText: string) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(currentText);
  return { editing, setEditing, confirming, setConfirming, draft, setDraft };
}

/**
 * Per-message "⋯" menu: quick reactions, edit (own outbound text, ~15min
 * window enforced server-side) and delete-for-everyone.
 */
export function MessageMenu({
  conversationId,
  messageId,
  currentText,
  canReact,
  canEdit,
  canDelete,
  replyTarget,
}: TargetProps & {
  currentText: string;
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Set on channel messages while the ticket is workable → shows "Responder". */
  replyTarget?: { externalId: string; preview: string } | undefined;
}) {
  const t = useTranslations("message");
  const tc = useTranslations("common");
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const { editing, setEditing, confirming, setConfirming, draft, setDraft } =
    useMessageMenuState(currentText);

  if (!canReact && !canEdit && !canDelete && !replyTarget) return null;

  if (editing) {
    return (
      <MessageEditForm
        tc={tc}
        draft={draft}
        pending={pending}
        onDraftChange={setDraft}
        onCancel={() => {
          setEditing(false);
          setDraft(currentText);
        }}
        onSave={() =>
          run(async () => {
            const r = await editMessageAction({ conversationId, messageId, text: draft.trim() });
            if (r.ok) setEditing(false);
            return r;
          })
        }
      />
    );
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-label={t("menuAria")}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setConfirming(false);
        }}
        className="text-ink-muted hover:text-ink rounded-xs px-1 text-sm opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      >
        ▾
      </button>
      {open && (
        <MessageMenuPanel
          t={t}
          tc={tc}
          canReact={canReact}
          canEdit={canEdit}
          canDelete={canDelete}
          confirming={confirming}
          pending={pending}
          onReact={(emoji) => {
            setOpen(false);
            run(() => reactToMessageAction({ conversationId, messageId, emoji }));
          }}
          onReply={
            replyTarget
              ? () => {
                  setOpen(false);
                  setReplyTarget(replyTarget);
                }
              : undefined
          }
          onEdit={() => {
            setOpen(false);
            setEditing(true);
          }}
          onDeleteStart={() => setConfirming(true)}
          onDeleteCancel={() => setConfirming(false)}
          onDeleteConfirm={() => run(() => deleteMessageAction({ conversationId, messageId }))}
        />
      )}
    </span>
  );
}

function MessageEditForm({
  draft,
  pending,
  onDraftChange,
  onSave,
  onCancel,
  tc,
}: {
  tc: ReturnType<typeof useTranslations>;
  draft: string;
  pending: boolean;
  onDraftChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-1 space-y-1" data-testid="edit-message-form">
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        rows={2}
        className="border-line bg-page w-full rounded-md border px-2 py-1 text-sm"
        disabled={pending}
      />
      <div className="flex gap-1 text-xs">
        <button
          type="button"
          className="bg-signal text-ink-on-signal rounded-xs px-2 py-1"
          disabled={pending || !draft.trim()}
          onClick={onSave}
        >
          {tc("save")}
        </button>
        <button type="button" className="rounded-xs border px-2 py-1" onClick={onCancel}>
          {tc("cancel")}
        </button>
      </div>
    </div>
  );
}

const MENU_PANEL_CLASS =
  "bg-raised text-ink shadow-raised flex min-w-36 flex-col gap-0.5 rounded-md border p-1 text-xs";

type MenuItemsProps = {
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  confirming: boolean;
  pending: boolean;
  onReact: (emoji: string) => void;
  onReply?: (() => void) | undefined;
  onEdit: () => void;
  onDeleteStart: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
};

function MessageMenuItems({
  t,
  tc,
  canReact,
  canEdit,
  canDelete,
  confirming,
  pending,
  onReact,
  onReply,
  onEdit,
  onDeleteStart,
  onDeleteCancel,
  onDeleteConfirm,
}: MenuItemsProps) {
  const item = "hover:bg-raised rounded-xs px-2 py-1 text-left";
  return (
    <>
      {canReact && (
        <span className="flex gap-0.5 px-1 py-0.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="hover:bg-raised text-md rounded-xs p-0.5"
              onClick={() => onReact(emoji)}
            >
              {emoji}
            </button>
          ))}
        </span>
      )}
      {onReply && (
        <button type="button" className={item} onClick={onReply}>
          {t("reply")}
        </button>
      )}
      {canEdit && (
        <button type="button" className={item} onClick={onEdit}>
          {t("edit")}
        </button>
      )}
      {canDelete &&
        (confirming ? (
          <span className="flex items-center gap-1 px-2 py-1">
            {t("deleteConfirm")}
            <button
              type="button"
              className="text-danger font-medium"
              disabled={pending}
              onClick={onDeleteConfirm}
            >
              {tc("yes")}
            </button>
            <button type="button" onClick={onDeleteCancel}>
              {tc("no")}
            </button>
          </span>
        ) : (
          <button type="button" className={cn(item, "text-danger")} onClick={onDeleteStart}>
            {t("delete")}
          </button>
        ))}
    </>
  );
}

function MessageMenuPanel(props: MenuItemsProps) {
  return (
    <span
      className={cn(MENU_PANEL_CLASS, "absolute top-full right-0 z-10")}
      data-testid="message-menu"
    >
      <MessageMenuItems {...props} />
    </span>
  );
}

/** Click-away outside the panel, Escape and scroll dismiss it; clicks inside must not. */
function useDismissOnOutside(active: boolean, close: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [active, close]);
  return panelRef;
}

/** Only one floating context menu at a time — opening closes the previous. */
let closeCurrentContextMenu: (() => void) | null = null;

/**
 * Right-click (contextmenu) trigger: wraps a message bubble and opens the
 * same actions as the "⋯" menu, but as a floating panel at the cursor.
 * `display: contents` keeps the layout identical — the wrapper is an event
 * boundary only. Nothing to show → the native menu stays.
 */
export function MessageContextMenu({
  children,
  conversationId,
  messageId,
  currentText,
  canReact,
  canEdit,
  canDelete,
  replyTarget,
}: TargetProps & {
  children: React.ReactNode;
  currentText: string;
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  replyTarget?: { externalId: string; preview: string } | undefined;
}) {
  const t = useTranslations("message");
  const tc = useTranslations("common");
  const { pending, run } = useAction();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const { editing, setEditing, confirming, setConfirming, draft, setDraft } =
    useMessageMenuState(currentText);

  const enabled = canReact || canEdit || canDelete || !!replyTarget;

  const close = () => {
    setPos(null);
    setEditing(false);
    setConfirming(false);
    if (closeCurrentContextMenu) closeCurrentContextMenu = null;
  };

  const panelRef = useDismissOnOutside(pos !== null, close);

  const open = (e: React.MouseEvent) => {
    if (!enabled) return;
    e.preventDefault();
    closeCurrentContextMenu?.();
    setEditing(false);
    setConfirming(false);
    setDraft(currentText);
    setPos({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 220),
    });
    closeCurrentContextMenu = close;
  };

  return (
    <>
      <div className="contents" onContextMenu={open}>
        {children}
      </div>
      {pos && (
        <div
          ref={panelRef}
          className="fixed top-(--ctx-menu-y) left-(--ctx-menu-x) z-50"
          style={{ "--ctx-menu-x": `${pos.x}px`, "--ctx-menu-y": `${pos.y}px` } as CSSProperties}
          data-testid="message-context-menu"
        >
          <span className={cn(MENU_PANEL_CLASS, "block", editing && "min-w-64")}>
            {editing ? (
              <MessageEditForm
                tc={tc}
                draft={draft}
                pending={pending}
                onDraftChange={setDraft}
                onCancel={() => setEditing(false)}
                onSave={() =>
                  run(async () => {
                    const r = await editMessageAction({
                      conversationId,
                      messageId,
                      text: draft.trim(),
                    });
                    if (r.ok) close();
                    return r;
                  })
                }
              />
            ) : (
              <MessageMenuItems
                t={t}
                tc={tc}
                canReact={canReact}
                canEdit={canEdit}
                canDelete={canDelete}
                confirming={confirming}
                pending={pending}
                onReact={(emoji) => {
                  close();
                  run(() => reactToMessageAction({ conversationId, messageId, emoji }));
                }}
                onReply={
                  replyTarget
                    ? () => {
                        close();
                        setReplyTarget(replyTarget);
                      }
                    : undefined
                }
                onEdit={() => setEditing(true)}
                onDeleteStart={() => setConfirming(true)}
                onDeleteCancel={() => setConfirming(false)}
                onDeleteConfirm={() =>
                  run(async () => {
                    const r = await deleteMessageAction({ conversationId, messageId });
                    if (r.ok) close();
                    return r;
                  })
                }
              />
            )}
          </span>
        </div>
      )}
    </>
  );
}

/** "(editada)" — privileged roles can expand the previous versions. */
export function EditedIndicator({
  conversationId,
  messageId,
  canInspect,
}: TargetProps & { canInspect: boolean }) {
  const t = useTranslations("message");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<{ previousText: string | null; createdAt: string }[] | null>(
    null,
  );
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
      {open && edits && (
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
      )}
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

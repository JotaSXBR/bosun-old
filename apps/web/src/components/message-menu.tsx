"use client";

// Per-message "⋯" menu (react/reply/edit/delete) and the pieces the
// right-click context menu shares with it. Mutations are server actions →
// router.refresh() (see useAction).
import { cn } from "@crm/design-system/lib/utils";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { MENU_PANEL_CLASS, MenuItemsView } from "@/components/message-menu-items";
import { setReplyTarget } from "@/lib/reply-bridge";
import { useAction } from "@/lib/use-action";
import {
  deleteMessageAction,
  editMessageAction,
  reactToMessageAction,
} from "@/server/actions/chat";

export type TargetProps = { conversationId: string; messageId: string };
type Run = ReturnType<typeof useAction>["run"];

export type MenuAccess = {
  currentText: string;
  canReact: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Set on channel messages while the ticket is workable → shows "Responder". */
  replyTarget?: { externalId: string; preview: string } | undefined;
};

/** Edit / delete-confirm / draft-text state shared by both menu flavors. */
export function useMessageMenuState(currentText: string) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(currentText);
  const cancelEdit = () => {
    setEditing(false);
    setDraft(currentText);
  };
  return { editing, setEditing, confirming, setConfirming, draft, setDraft, cancelEdit };
}

export type MenuState = ReturnType<typeof useMessageMenuState>;

/** Callers pass wider objects (menu props); a Server Action must only get the ids. */
const pickTarget = ({ conversationId, messageId }: TargetProps): TargetProps => ({
  conversationId,
  messageId,
});

/** React / reply / delete callbacks; `close` hides the menu, `afterDelete` runs on success. */
export function messageHandlers(args: {
  target: TargetProps;
  run: Run;
  replyTarget: MenuAccess["replyTarget"];
  close: () => void;
  afterDelete?: () => void;
}) {
  const { run, replyTarget, close, afterDelete } = args;
  const target = pickTarget(args.target);
  return {
    onReact: (emoji: string) => {
      close();
      run(() => reactToMessageAction({ ...target, emoji }));
    },
    onReply: replyTarget
      ? () => {
          close();
          setReplyTarget(replyTarget);
        }
      : undefined,
    onDeleteConfirm: () =>
      run(async () => {
        const r = await deleteMessageAction(target);
        if (r.ok) afterDelete?.();
        return r;
      }),
  };
}

/** Edit textarea wired to the edit action; `onSaved` runs once the edit succeeded. */
export function MessageEditor(props: {
  target: TargetProps;
  menu: MenuState;
  pending: boolean;
  run: Run;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { menu, pending, run, onSaved, onCancel } = props;
  const target = pickTarget(props.target);
  const tc = useTranslations("common");
  return (
    <MessageEditForm
      tc={tc}
      draft={menu.draft}
      pending={pending}
      onDraftChange={menu.setDraft}
      onCancel={onCancel}
      onSave={() =>
        run(async () => {
          const r = await editMessageAction({ ...target, text: menu.draft.trim() });
          if (r.ok) onSaved();
          return r;
        })
      }
    />
  );
}

function MenuTrigger({ open, onClick }: { open: boolean; onClick: () => void }) {
  const t = useTranslations("message");
  return (
    <button
      type="button"
      aria-label={t("menuAria")}
      aria-expanded={open}
      onClick={onClick}
      className="text-ink-muted hover:text-ink rounded-xs px-1 text-sm opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
    >
      ▾
    </button>
  );
}

/**
 * Per-message "⋯" menu: quick reactions, edit (own outbound text, ~15min
 * window enforced server-side) and delete-for-everyone.
 */
export function MessageMenu(props: TargetProps & MenuAccess) {
  const { canReact, canEdit, canDelete, replyTarget, currentText } = props;
  const { pending, run } = useAction();
  const [open, setOpen] = useState(false);
  const menu = useMessageMenuState(currentText);
  const handlers = messageHandlers({
    target: props,
    run,
    replyTarget,
    close: () => setOpen(false),
  });

  if (!canReact && !canEdit && !canDelete && !replyTarget) return null;

  if (menu.editing) {
    return (
      <MessageEditor
        target={props}
        menu={menu}
        pending={pending}
        run={run}
        onSaved={() => menu.setEditing(false)}
        onCancel={menu.cancelEdit}
      />
    );
  }

  return (
    <span className="relative inline-block">
      <MenuTrigger
        open={open}
        onClick={() => {
          setOpen((v) => !v);
          menu.setConfirming(false);
        }}
      />
      {open && (
        <MessageMenuPanel>
          <MenuItemsView
            access={props}
            menu={menu}
            pending={pending}
            handlers={handlers}
            onEdit={() => {
              setOpen(false);
              menu.setEditing(true);
            }}
          />
        </MessageMenuPanel>
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

function MessageMenuPanel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={cn(MENU_PANEL_CLASS, "absolute top-full right-0 z-10")}
      data-testid="message-menu"
    >
      {children}
    </span>
  );
}

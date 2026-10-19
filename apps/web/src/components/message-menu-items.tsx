"use client";

import { cn } from "@crm/design-system/lib/utils";
import { useTranslations } from "next-intl";

import type { MenuAccess, MenuState, messageHandlers } from "@/components/message-menu";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;

export const MENU_PANEL_CLASS =
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

function ReactionBar({ onReact }: { onReact: (emoji: string) => void }) {
  return (
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
  );
}

const ITEM_CLASS = "hover:bg-raised rounded-xs px-2 py-1 text-left";

function DeleteControl(
  props: Pick<
    MenuItemsProps,
    "t" | "tc" | "confirming" | "pending" | "onDeleteStart" | "onDeleteCancel" | "onDeleteConfirm"
  >,
) {
  const { t, tc, confirming, pending, onDeleteStart, onDeleteCancel, onDeleteConfirm } = props;
  if (!confirming) {
    return (
      <button type="button" className={cn(ITEM_CLASS, "text-danger")} onClick={onDeleteStart}>
        {t("delete")}
      </button>
    );
  }
  return (
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
  );
}

/** Menu items wired to the shared menu state and handlers (both menu flavors). */
export function MenuItemsView({
  access,
  menu,
  pending,
  handlers,
  onEdit,
}: {
  access: MenuAccess;
  menu: MenuState;
  pending: boolean;
  handlers: ReturnType<typeof messageHandlers>;
  onEdit: () => void;
}) {
  const t = useTranslations("message");
  const tc = useTranslations("common");
  return (
    <MessageMenuItems
      t={t}
      tc={tc}
      canReact={access.canReact}
      canEdit={access.canEdit}
      canDelete={access.canDelete}
      confirming={menu.confirming}
      pending={pending}
      {...handlers}
      onEdit={onEdit}
      onDeleteStart={() => menu.setConfirming(true)}
      onDeleteCancel={() => menu.setConfirming(false)}
    />
  );
}

function MessageMenuItems(props: MenuItemsProps) {
  const { t, canReact, canEdit, canDelete, onReact, onReply, onEdit } = props;
  return (
    <>
      {canReact && <ReactionBar onReact={onReact} />}
      {onReply && (
        <button type="button" className={ITEM_CLASS} onClick={onReply}>
          {t("reply")}
        </button>
      )}
      {canEdit && (
        <button type="button" className={ITEM_CLASS} onClick={onEdit}>
          {t("edit")}
        </button>
      )}
      {canDelete && <DeleteControl {...props} />}
    </>
  );
}

"use client";

import { cn } from "@crm/design-system/lib/utils";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";

import {
  type MenuAccess,
  MessageEditor,
  messageHandlers,
  type TargetProps,
  useMessageMenuState,
} from "@/components/message-menu";
import { MENU_PANEL_CLASS, MenuItemsView } from "@/components/message-menu-items";
import { useAction } from "@/lib/use-action";

/** Click-away outside the panel, Escape and scroll dismiss it; clicks inside must not. */
function useDismissOnOutside(active: boolean, close: () => void) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (!panelRef.current || !e.composedPath().includes(panelRef.current)) close();
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

type Pos = { x: number; y: number; id: number };

function ContextPanel(
  props: TargetProps &
    MenuAccess & {
      pos: Pos;
      panelRef: React.RefObject<HTMLDivElement | null>;
      close: () => void;
    },
) {
  const { pos, panelRef, close, replyTarget, currentText } = props;
  const { pending, run } = useAction();
  const menu = useMessageMenuState(currentText);
  const { editing, setEditing } = menu;
  const handlers = messageHandlers({
    target: props,
    run,
    replyTarget,
    close,
    afterDelete: close,
  });

  return (
    <div
      ref={panelRef}
      className="fixed top-(--ctx-menu-y) left-(--ctx-menu-x) z-50"
      style={{ "--ctx-menu-x": `${pos.x}px`, "--ctx-menu-y": `${pos.y}px` } as CSSProperties}
      data-testid="message-context-menu"
    >
      <span className={cn(MENU_PANEL_CLASS, "block", editing && "min-w-64")}>
        {editing ? (
          <MessageEditor
            target={props}
            menu={menu}
            pending={pending}
            run={run}
            onSaved={close}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <MenuItemsView
            access={props}
            menu={menu}
            pending={pending}
            handlers={handlers}
            onEdit={() => setEditing(true)}
          />
        )}
      </span>
    </div>
  );
}

/**
 * Right-click (contextmenu) trigger: wraps a message bubble and opens the
 * same actions as the "⋯" menu, but as a floating panel at the cursor.
 * `display: contents` keeps the layout identical — the wrapper is an event
 * boundary only. Nothing to show → the native menu stays.
 */
export function MessageContextMenu(
  props: TargetProps & MenuAccess & { children: React.ReactNode },
) {
  const { children, ...target } = props;
  const { canReact, canEdit, canDelete, replyTarget } = target;
  const [pos, setPos] = useState<Pos | null>(null);
  const enabled = canReact || canEdit || canDelete || !!replyTarget;

  const close = useCallback(() => {
    setPos(null);
    closeCurrentContextMenu = null;
  }, []);
  const panelRef = useDismissOnOutside(pos !== null, close);

  const open = (e: React.MouseEvent) => {
    if (!enabled) return;
    e.preventDefault();
    closeCurrentContextMenu?.();
    setPos({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 220),
      id: e.timeStamp,
    });
    closeCurrentContextMenu = close;
  };

  return (
    <>
      <div className="contents" onContextMenu={open}>
        {children}
      </div>
      {pos && <ContextPanel key={pos.id} {...target} pos={pos} panelRef={panelRef} close={close} />}
    </>
  );
}

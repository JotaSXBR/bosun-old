"use client";

import { cn } from "@crm/design-system/lib/utils";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";

import { Icon, type IconName } from "../components/icon";
import { Input } from "../components/input";

export interface CommandItem {
  id: string;
  icon: IconName;
  label: string;
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandGroup {
  label: string;
  items: CommandItem[];
}

/** Ctrl/⌘+K shortcut that opens the palette. */
export function useCommandShortcut(onOpen: () => void) {
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const Kbd = () => (
  <kbd className="border-line text-2xs text-ink-subtle rounded-xs border px-1.5 py-0.5 font-mono">
    esc
  </kbd>
);

/**
 * ⌘K command palette — filtered, keyboard-navigable list of actions grouped
 * by section. Case- and accent-insensitive matching on label + keywords.
 */
export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: CommandGroup[];
  /** @default "Buscar conteúdo e ações" */
  placeholder?: string;
  /** @default (q) => `Nenhum resultado para “${q}”.` */
  emptyLabel?: (query: string) => string;
  /** Accessible title (visually hidden). @default "Buscar" */
  title?: string;
}

function useFilteredGroups(groups: CommandGroup[], query: string) {
  const filtered = React.useMemo(() => {
    const q = normalize(query);
    const matches = (i: CommandItem) =>
      normalize(i.label).includes(q) || (i.keywords ?? []).some((k) => normalize(k).includes(q));
    const withMatches = (g: CommandGroup) => ({ ...g, items: g.items.filter(matches) });
    return groups.map(withMatches).filter((g) => g.items.length > 0);
  }, [groups, query]);
  const flat = React.useMemo(() => filtered.flatMap((g) => g.items), [filtered]);
  return { filtered, flat };
}

/** Query, highlighted row and keyboard navigation of the palette. */
function useCommandPalette({
  open,
  groups,
  onOpenChange,
}: Pick<CommandPaletteProps, "open" | "groups" | "onOpenChange">) {
  const [query, setQuery] = React.useState("");
  const [activeId, setActiveId] = React.useState<string>();

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveId(undefined);
    }
  }, [open]);

  const { filtered, flat } = useFilteredGroups(groups, query);
  const active = activeId && flat.some((i) => i.id === activeId) ? activeId : flat[0]?.id;

  const run = (item: CommandItem) => {
    item.onSelect();
    onOpenChange(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const idx = flat.findIndex((i) => i.id === active);
      const next =
        e.key === "ArrowDown" ? (idx + 1) % flat.length : (idx - 1 + flat.length) % flat.length;
      setActiveId(flat[next]?.id);
    } else if (e.key === "Enter" && active) {
      e.preventDefault();
      const item = flat.find((i) => i.id === active);
      if (item) run(item);
    }
  };

  return { query, setQuery, setActiveId, filtered, active, run, onKeyDown };
}

function CommandRow({
  item,
  id,
  selected,
  onRun,
  onHover,
}: {
  item: CommandItem;
  id: string;
  selected: boolean;
  onRun: () => void;
  onHover: () => void;
}) {
  return (
    <button
      id={id}
      type="button"
      tabIndex={-1}
      role="option"
      aria-selected={selected}
      onClick={onRun}
      onMouseMove={onHover}
      className={cn(
        "text-ui-lg flex h-11 w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2.5 text-left font-sans transition-colors",
        selected ? "bg-raised text-ink-strong" : "text-ink",
      )}
    >
      <span className="bg-control text-icon inline-flex size-7.5 items-center justify-center rounded-full">
        <Icon name={item.icon} size={15} />
      </span>
      <span className="flex-1">{item.label}</span>
      <Icon name="arrow-right" size={15} className="text-icon-muted" />
    </button>
  );
}

function CommandList({
  listId,
  filtered,
  active,
  empty,
  onRun,
  onHover,
}: {
  listId: string;
  filtered: CommandGroup[];
  active: string | undefined;
  empty: string;
  onRun: (item: CommandItem) => void;
  onHover: (id: string) => void;
}) {
  return (
    <div id={listId} role="listbox" className="overflow-auto px-1 pt-1 pb-1.5">
      {filtered.length === 0 && (
        <div className="text-ink-muted px-3 py-7 text-center text-sm">{empty}</div>
      )}
      {filtered.map((g, gi) => (
        <div key={g.label} role="group" aria-labelledby={`${listId}-g${gi}`}>
          <div
            id={`${listId}-g${gi}`}
            className="text-2xs tracking-mono text-ink-subtle mt-2 px-2.5 py-1.5 font-mono uppercase"
          >
            {g.label}
          </div>
          {g.items.map((item) => (
            <CommandRow
              key={item.id}
              item={item}
              id={`${listId}-${item.id}`}
              selected={item.id === active}
              onRun={() => onRun(item)}
              onHover={() => onHover(item.id)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function PaletteFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="bg-overlay backdrop-blur-overlay animate-fade fixed inset-0 z-110" />
      <div className="pointer-events-none fixed inset-0 z-110 flex justify-center">
        <DialogPrimitive.Content
          className="bg-surface rounded-card shadow-pop animate-rise pointer-events-auto mt-30 flex max-h-115 w-full max-w-160 flex-col gap-2 self-start p-3 outline-none"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  groups,
  placeholder = "Buscar conteúdo e ações",
  emptyLabel = (q) => `Nenhum resultado para “${q}”.`,
  title = "Buscar",
}: CommandPaletteProps) {
  const listId = React.useId();
  const { query, setQuery, setActiveId, filtered, active, run, onKeyDown } = useCommandPalette({
    open,
    groups,
    onOpenChange,
  });

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PaletteFrame title={title}>
        <Input
          autoFocus
          size="lg"
          icon="search"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveId(undefined);
          }}
          onKeyDown={onKeyDown}
          trailing={<Kbd />}
          role="combobox"
          aria-expanded={true}
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${active}` : undefined}
        />
        <CommandList
          listId={listId}
          filtered={filtered}
          active={active}
          empty={emptyLabel(query)}
          onRun={run}
          onHover={setActiveId}
        />
      </PaletteFrame>
    </DialogPrimitive.Root>
  );
}

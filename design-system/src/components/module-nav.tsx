"use client";

import { cn } from "@crm/design-system/lib/utils";
import * as React from "react";

import { Icon, type IconName } from "./icon";

export interface ModuleNavItem {
  id: string;
  label: string;
  /** Lucide icon */
  icon?: IconName;
  badge?: number;
  href?: string;
}

/**
 * Primary module navigation — a row of icon+label pills (desktop top bar) or
 * icon discs (compact / mobile dock).
 */
export interface ModuleNavProps extends Omit<React.ComponentProps<"nav">, "onChange"> {
  items: ModuleNavItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Icon-only 48px discs; active disc filled Verde sinal. */
  compact?: boolean;
  /** Rendered when the item has an href. @default "a" */
  linkComponent?: React.ElementType;
}

export function ModuleNav({
  items = [],
  value,
  defaultValue,
  onChange,
  compact = false,
  linkComponent: Link = "a",
  "aria-label": ariaLabel = "Módulos",
  className,
  ...props
}: ModuleNavProps) {
  const [inner, setInner] = React.useState(() => defaultValue ?? items[0]?.id);
  const cur = value ?? inner;
  const pick = (id: string) => {
    setInner(id);
    onChange?.(id);
  };

  return (
    <nav
      aria-label={ariaLabel}
      className={cn("flex flex-wrap items-center", compact ? "gap-2" : "gap-1.5", className)}
      {...props}
    >
      {items.map((it) => (
        <NavItem
          key={it.id}
          item={it}
          active={it.id === cur}
          compact={compact}
          linkComponent={Link}
          onPick={pick}
        />
      ))}
    </nav>
  );
}

function navItemClass(on: boolean, compact: boolean) {
  const base =
    "inline-flex cursor-pointer items-center justify-center font-sans whitespace-nowrap outline-none transition-all duration-fast ease-standard focus-visible:shadow-focus";
  const box = compact
    ? cn(
        "size-12 rounded-full border p-0",
        on
          ? "border-transparent bg-signal text-ink-on-signal"
          : "border-line-subtle bg-control text-icon hover:bg-control-hover",
      )
    : cn(
        "h-control-md gap-2 rounded-pill border pr-4 pl-3.5 text-sm",
        on
          ? "border-line-accent bg-signal-soft text-ink-accent hover:text-ink-accent"
          : "border-line-subtle bg-control text-ink shadow-control hover:bg-control-hover hover:text-ink",
      );
  return cn(base, on ? "font-medium" : "font-normal", box);
}

function NavBadge({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "text-2xs inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1 font-semibold",
        on ? "bg-signal text-ink-on-signal" : "bg-raised-2 text-ink",
      )}
    >
      {children}
    </span>
  );
}

function NavItem({
  item: it,
  active: on,
  compact,
  linkComponent: Link = "a",
  onPick,
}: {
  item: ModuleNavItem;
  active: boolean;
  compact: boolean;
  linkComponent: React.ElementType;
  onPick: (id: string) => void;
}) {
  const shared = navItemClass(on, compact);
  const inner = (
    <>
      {it.icon && <Icon name={it.icon} size={compact ? 20 : 17} />}
      {!compact && it.label}
      {!compact && it.badge != null && <NavBadge on={on}>{it.badge}</NavBadge>}
    </>
  );
  const a11y = {
    "aria-current": on ? ("page" as const) : undefined,
    "aria-label": compact ? it.label : undefined,
    title: compact ? it.label : undefined,
  };
  const handleClick = () => onPick(it.id);
  return it.href ? (
    <Link
      href={it.href}
      onClick={handleClick}
      className={cn(shared, "hover:no-underline")}
      {...a11y}
    >
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={handleClick} className={shared} {...a11y}>
      {inner}
    </button>
  );
}

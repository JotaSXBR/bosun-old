"use client";

import { cn } from "@crm/design-system/lib/utils";
import * as React from "react";

/**
 * The BOSUN module card. With `actions`, the top-right corner is notched out
 * and the actions sit in the cut — the signature "tab" silhouette. Without
 * actions it's a plain 24px-radius tile.
 *
 * Numeric props default to the design tokens (`--radius-card`, `--card-pad`,
 * `--radius-notch`, `--text-lg`); pass a number only to override.
 */
export interface CardProps extends Omit<React.ComponentProps<"section">, "title"> {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Optional node above the title (e.g. an icon disc). */
  icon?: React.ReactNode;
  /** IconButtons placed in the notched corner. Presence of actions turns the notch on. */
  actions?: React.ReactNode;
  /** default = card surface; raised = nested card; accent = Verde sinal (max one per row); sunken. @default "default" */
  tone?: "default" | "raised" | "accent" | "sunken";
  /** Card padding in px. @default --card-pad (24) */
  padding?: number;
  /** Corner radius in px. @default --radius-card (24) */
  radius?: number;
  /** Gap between card edge and notched actions, in px. @default 8 */
  notchGap?: number;
  /** Concave fillet radius at the notch, in px. @default --radius-notch (16) */
  fillet?: number;
  /** Title size in px. @default --text-lg (18) */
  titleSize?: number;
  /** Classes/styles applied to the body wrapper only. */
  bodyClassName?: string;
  bodyStyle?: React.CSSProperties;
}

function CardHead({
  title,
  subtitle,
  icon,
  titleSize,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  titleSize?: number;
}) {
  if (!title && !subtitle && !icon) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {icon}
      {title && (
        <div
          className={cn(
            "bx-card-title font-display tracking-card font-medium text-balance",
            titleSize === undefined
              ? "text-lg"
              : "text-(length:--card-title-fs) leading-(--text-lg--line-height)",
          )}
          style={
            titleSize === undefined
              ? undefined
              : ({ "--card-title-fs": `${titleSize}px` } as React.CSSProperties)
          }
        >
          {title}
        </div>
      )}
      {subtitle && <div className="bx-card-meta text-ui">{subtitle}</div>}
    </div>
  );
}

type CardShell = {
  rootProps: React.ComponentProps<"section">;
  ref?: React.Ref<HTMLElement>;
  head: React.ReactNode;
  padding?: number;
  radius?: number;
  style?: React.CSSProperties;
  bodyClassName?: string;
  bodyStyle?: React.CSSProperties;
  children: React.ReactNode;
};

/** Root <section> props: tone, interactivity (button semantics + Enter/Space) and caller props. */
function cardRootProps({
  tone,
  className,
  onClick,
  onKeyDown,
  props,
}: Pick<CardProps, "tone" | "className" | "onClick" | "onKeyDown"> & {
  props: React.ComponentProps<"section">;
}) {
  const interactive = Boolean(onClick);
  const keyboard = interactive
    ? {
        role: "button" as const,
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
          if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
            e.preventDefault();
            onClick?.(e as unknown as React.MouseEvent<HTMLElement>);
          }
          onKeyDown?.(e);
        },
      }
    : {};

  return {
    "data-tone": tone,
    "data-interactive": interactive || undefined,
    className: cn(
      "bx-card flex min-w-0 flex-col text-left outline-none",
      interactive && "focus-visible:shadow-focus",
      className,
    ),
    onClick,
    onKeyDown,
    ...keyboard,
    ...props,
  };
}

export function Card({
  title,
  subtitle,
  icon,
  actions,
  tone = "default",
  padding,
  radius,
  notchGap,
  fillet,
  titleSize,
  children,
  className,
  style,
  bodyClassName,
  bodyStyle,
  onClick,
  onKeyDown,
  ref,
  ...props
}: CardProps) {
  const shell: CardShell = {
    rootProps: cardRootProps({ tone, className, onClick, onKeyDown, props }),
    ref,
    head: <CardHead title={title} subtitle={subtitle} icon={icon} titleSize={titleSize} />,
    padding,
    radius,
    style,
    bodyClassName,
    bodyStyle,
    children,
  };
  return actions ? (
    <NotchedCard {...shell} actions={actions} notchGap={notchGap} fillet={fillet} />
  ) : (
    <PlainCard {...shell} />
  );
}

function PlainCard({
  rootProps,
  ref,
  head,
  padding,
  radius,
  style,
  bodyClassName,
  bodyStyle,
  children,
}: CardShell) {
  return (
    <section
      ref={ref}
      {...rootProps}
      className={cn(
        rootProps.className,
        "bx-card-part bx-card-shadow gap-4 rounded-(--card-radius) p-(--card-pad)",
      )}
      style={
        {
          "--card-radius": radius === undefined ? "var(--radius-card)" : `${radius}px`,
          "--card-pad": padding === undefined ? undefined : `${padding}px`,
          ...style,
        } as React.CSSProperties
      }
    >
      {head}
      {children != null && (
        <div
          className={cn("flex min-w-0 flex-1 flex-col", bodyClassName)}
          // eslint-disable-next-line shadcn/no-inline-styles -- caller-provided style passthrough; not statically checkable
          style={bodyStyle}
        >
          {children}
        </div>
      )}
    </section>
  );
}

function NotchedTop({ head, actions }: { head: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="flex items-stretch">
      <div className="bx-card-part bx-card-shadow relative min-w-0 flex-1 rounded-t-(--card-radius) px-(--card-pad) pt-(--card-tab-pt)">
        {head}
        <span aria-hidden="true" className="card-fillet" />
      </div>
      <div className="flex items-start gap-2 pb-(--card-notch-gap) pl-(--card-notch-gap)">
        {actions}
      </div>
    </div>
  );
}

function NotchedCard({
  rootProps,
  ref,
  head,
  actions,
  padding,
  radius,
  notchGap,
  fillet,
  style,
  bodyClassName,
  bodyStyle,
  children,
}: CardShell & { actions: React.ReactNode; notchGap?: number; fillet?: number }) {
  const padN = padding ?? 24;
  const gapN = notchGap ?? 8;
  return (
    <section
      ref={ref}
      {...rootProps}
      style={
        {
          "--card-radius": radius === undefined ? "var(--radius-card)" : `${radius}px`,
          "--card-notch-fillet": fillet === undefined ? undefined : `${fillet}px`,
          "--card-pad": `${padN}px`,
          "--card-tab-pt": `${padN - 4}px`,
          "--card-notch-gap": `${gapN}px`,
          "--card-body-pt": `${gapN + 4}px`,
          ...style,
        } as React.CSSProperties
      }
    >
      <NotchedTop head={head} actions={actions} />
      <div
        className={cn(
          "bx-card-part flex min-w-0 flex-1 flex-col rounded-tr-(--card-radius) rounded-b-(--card-radius) px-(--card-pad) pt-(--card-body-pt) pb-(--card-pad)",
          bodyClassName,
        )}
        // eslint-disable-next-line shadcn/no-inline-styles -- caller-provided style passthrough; not statically checkable
        style={bodyStyle}
      >
        {children}
      </div>
    </section>
  );
}

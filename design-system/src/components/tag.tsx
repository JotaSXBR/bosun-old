"use client";

import { cn } from "@crm/design-system/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { Icon, type IconName } from "./icon";

const tagVariants = cva(
  "inline-flex items-center gap-2 rounded-pill border font-sans font-medium whitespace-nowrap select-none",
  {
    variants: {
      selected: {
        false: "border-line-subtle bg-control text-ink-strong shadow-control",
        true: "border-line-accent bg-signal-soft text-ink-accent",
      },
      size: {
        sm: "h-7.5 text-xs",
        md: "h-9.5 text-ui",
      },
      removable: {
        true: "pr-2 pl-4",
        false: "px-4",
      },
      interactive: {
        true: "cursor-pointer transition-all duration-fast ease-standard focus-visible:shadow-focus hover:bg-control-hover",
      },
    },
    compoundVariants: [{ selected: true, interactive: true, class: "hover:bg-signal-soft" }],
    defaultVariants: { selected: false, size: "md" },
  },
);

/** Filter / facet chip, optionally removable. */
export interface TagProps
  extends Omit<React.ComponentProps<"button">, "children">, VariantProps<typeof tagVariants> {
  children?: React.ReactNode;
  /** Lucide icon before the label. */
  icon?: IconName;
  /** Renders an × button; called when it's clicked. */
  onRemove?: (e: React.MouseEvent) => void;
  removeLabel?: string;
}

function RemoveButton({
  onRemove,
  label,
}: {
  onRemove: (e: React.MouseEvent) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onRemove(e);
      }}
      className="duration-fast ease-standard hover:bg-raised-2 focus-visible:shadow-focus inline-flex size-6 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-inherit transition-colors outline-none"
    >
      <Icon name="x" size={14} strokeWidth={2} />
    </button>
  );
}

/** The label of a removable chip when it is also clickable (never nested in another button). */
function LabelButton({
  selected,
  ...props
}: React.ComponentProps<"button"> & { selected: boolean | null | undefined }) {
  return (
    <button
      aria-pressed={Boolean(selected)}
      className="focus-visible:shadow-focus inline-flex cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-inherit outline-none"
      {...props}
    />
  );
}

export function Tag({
  children,
  icon,
  selected = false,
  onRemove,
  onClick,
  removeLabel = "Remover filtro",
  size = "md",
  className,
  type = "button",
  ref,
  ...props
}: TagProps) {
  const content = (
    <>
      {icon && <Icon name={icon} size={15} />}
      {children}
    </>
  );
  const remove = onRemove && <RemoveButton onRemove={onRemove} label={removeLabel} />;

  // Never nest interactive elements: when removable, the root is a plain pill
  // and the label area becomes its own button.
  if (onRemove) {
    return (
      <span className={cn(tagVariants({ selected, size, removable: true }), className)}>
        {onClick ? (
          <LabelButton ref={ref} type={type} selected={selected} onClick={onClick} {...props}>
            {content}
          </LabelButton>
        ) : (
          content
        )}
        {remove}
      </span>
    );
  }

  if (onClick) {
    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={Boolean(selected)}
        onClick={onClick}
        className={cn(tagVariants({ selected, size, interactive: true }), className)}
        {...props}
      >
        {content}
      </button>
    );
  }

  return <span className={cn(tagVariants({ selected, size }), className)}>{content}</span>;
}

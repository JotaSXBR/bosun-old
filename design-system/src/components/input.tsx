"use client";

import { cn } from "@crm/design-system/lib/utils";
import * as React from "react";

import { Icon, type IconName } from "./icon";

const HEIGHTS = { sm: "h-control-sm", md: "h-control-md", lg: "h-control-lg" } as const;

/**
 * Text field — pill by default (search, filters); "rounded" for forms.
 * `className`/`style` go on the outer label; everything else lands on the
 * native `<input>` (compatible with FormControl from form.tsx).
 */
export interface InputProps extends Omit<React.ComponentProps<"input">, "size"> {
  label?: string;
  hint?: string;
  /** Error message; turns the border red and replaces the hint. */
  error?: string;
  /** Leading Lucide icon, e.g. "search". */
  icon?: IconName;
  /** Node at the right edge (e.g. a <kbd>⌘K</kbd> or IconButton). */
  trailing?: React.ReactNode;
  /** @default "md" */
  size?: keyof typeof HEIGHTS;
  /** @default "pill" */
  shape?: "pill" | "rounded";
  /** Inline style for the inner <input> only. */
  inputStyle?: React.CSSProperties;
}

function fieldMeta({
  fid,
  error,
  hint,
  described,
}: {
  fid: string;
  error?: string;
  hint?: string;
  described?: string;
}) {
  const hintId = `${fid}-hint`;
  const errorId = `${fid}-error`;
  const joined = [described, error ? errorId : hint ? hintId : undefined].filter(Boolean).join(" ");
  return { describedBy: joined || undefined, noteId: error ? errorId : hintId };
}

function FieldBox({
  size,
  shape,
  invalid,
  icon,
  trailing,
  input,
}: {
  size: keyof typeof HEIGHTS;
  shape: "pill" | "rounded";
  invalid: React.AriaAttributes["aria-invalid"];
  icon?: IconName;
  trailing?: React.ReactNode;
  input: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "group bg-sunken duration-fast ease-standard flex items-center gap-2.5 border px-4 transition-all",
        HEIGHTS[size],
        shape === "pill" ? "rounded-pill" : "rounded-md",
        invalid
          ? "border-danger focus-within:border-danger focus-within:shadow-halo-danger"
          : "border-line focus-within:border-line-accent focus-within:shadow-halo",
      )}
    >
      {icon && (
        <Icon
          name={icon}
          size={17}
          className="text-icon-muted duration-fast group-focus-within:text-icon-strong transition-colors"
        />
      )}
      {input}
      {trailing}
    </span>
  );
}

function FieldNote({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  const text = error ?? hint;
  if (!text) return null;
  return (
    <span id={id} className={cn("text-xs", error ? "text-danger" : "text-ink-muted")}>
      {text}
    </span>
  );
}

function NativeInput({
  small,
  inputStyle,
  ...props
}: React.ComponentProps<"input"> & { small: boolean; inputStyle?: React.CSSProperties }) {
  return (
    <input
      className={cn(
        "text-ink-strong placeholder:text-ink-subtle h-full min-w-0 flex-1 border-0 bg-transparent outline-none focus-visible:shadow-none",
        small ? "text-ui" : "text-sm",
      )}
      // eslint-disable-next-line shadcn/no-inline-styles -- caller-provided style passthrough; not statically checkable
      style={inputStyle}
      {...props}
    />
  );
}

export function Input({
  label,
  hint,
  error,
  icon,
  trailing,
  size = "md",
  shape = "pill",
  disabled = false,
  id,
  className,
  style,
  inputStyle,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ref,
  ...props
}: InputProps) {
  const autoId = React.useId();
  const fid = id ?? autoId;
  const { describedBy, noteId } = fieldMeta({ fid, error, hint, described: ariaDescribedBy });
  const invalid = ariaInvalid ?? Boolean(error);
  return (
    <label
      htmlFor={fid}
      className={cn("flex min-w-0 flex-col gap-2", disabled && "opacity-50", className)}
      style={style}
    >
      {label && <span className="text-ui text-ink font-medium">{label}</span>}
      <FieldBox
        {...{ size, shape, invalid, icon, trailing }}
        input={
          <NativeInput
            ref={ref}
            id={fid}
            disabled={disabled}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            small={size === "sm"}
            inputStyle={inputStyle}
            {...props}
          />
        }
      />
      <FieldNote id={noteId} error={error} hint={hint} />
    </label>
  );
}

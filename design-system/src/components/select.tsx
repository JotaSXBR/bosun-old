"use client";

import { cn } from "@crm/design-system/lib/utils";
import { Select as SelectPrimitive } from "radix-ui";
import * as React from "react";

import { Icon, type IconName } from "./icon";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

/**
 * Pill dropdown for filters and single-choice fields.
 * Note: Radix forbids "" as an option value — use a sentinel like "all".
 */
export interface SelectProps {
  /** Strings or {value,label,disabled}. Values must be non-empty (Radix). */
  options: Array<string | SelectOption>;
  /** Controlled value. */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Shown when nothing is selected. @default "Selecionar" */
  placeholder?: string;
  label?: string;
  /** Leading Lucide icon. */
  icon?: IconName;
  /** @default "md" */
  size?: "sm" | "md";
  hint?: string;
  /** Error message; danger border, replaces the hint. */
  error?: string;
  disabled?: boolean;
  /** Form field name (posts the selected value). */
  name?: string;
  required?: boolean;
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  /** Extra aria-* attributes are applied to the trigger. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
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

function normalizeOptions(options: Array<string | SelectOption>): SelectOption[] {
  return options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

function fieldIds(fid: string, error?: string, hint?: string) {
  const hintId = `${fid}-hint`;
  const errorId = `${fid}-error`;
  return {
    describedId: error ? errorId : hint ? hintId : undefined,
    noteId: error ? errorId : hintId,
  };
}

function fieldDescribedBy(...ids: Array<string | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}

const TRIGGER_BASE =
  "group rounded-pill border-line-subtle bg-control text-ui shadow-control duration-fast ease-standard focus-visible:shadow-focus data-[state=open]:border-line-strong data-[state=open]:bg-control-hover inline-flex cursor-pointer items-center gap-2 border pr-3 pl-4 font-sans font-medium whitespace-nowrap transition-all outline-none disabled:cursor-not-allowed disabled:opacity-45";

function triggerClass({ size, error }: { size: "sm" | "md"; error?: string }) {
  return cn(
    TRIGGER_BASE,
    size === "sm" ? "h-control-sm" : "h-control-md",
    error && "border-danger",
  );
}

const ITEM_CLASS =
  "text-ui text-ink duration-fast data-[highlighted]:bg-control-hover data-[state=checked]:text-ink-accent flex h-9 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 whitespace-nowrap transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45";

function OptionItem({ option }: { option: SelectOption }) {
  return (
    <SelectPrimitive.Item value={option.value} disabled={option.disabled} className={ITEM_CLASS}>
      <span className="flex-1">
        <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
      </span>
      <SelectPrimitive.ItemIndicator>
        <Icon name="check" size={15} strokeWidth={2} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectTrigger({
  fid,
  label,
  icon,
  placeholder,
  size,
  error,
  describedId,
  aria,
}: {
  fid: string;
  label: SelectProps["label"];
  icon: SelectProps["icon"];
  placeholder: string;
  size: NonNullable<SelectProps["size"]>;
  error: SelectProps["error"];
  describedId: string | undefined;
  aria: Pick<SelectProps, "aria-describedby" | "aria-labelledby" | "aria-label" | "aria-invalid">;
}) {
  return (
    <SelectPrimitive.Trigger
      id={fid}
      aria-labelledby={label ? `${fid}-label` : aria["aria-labelledby"]}
      aria-label={aria["aria-label"]}
      aria-describedby={fieldDescribedBy(aria["aria-describedby"], describedId)}
      aria-invalid={error ? true : aria["aria-invalid"]}
      className={cn(triggerClass({ size, error }))}
    >
      {icon && <Icon name={icon} size={15} className="text-icon-muted" />}
      <span className="text-ink [&_[data-placeholder]]:text-ink-muted flex-1 text-left">
        <SelectPrimitive.Value placeholder={placeholder} />
      </span>
      <SelectPrimitive.Icon asChild>
        <Icon
          name="chevron-down"
          size={15}
          className="text-icon-muted duration-base ease-standard transition-transform group-data-[state=open]:rotate-180"
        />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function FieldLabel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span id={id} className="text-ui text-ink font-medium">
      {children}
    </span>
  );
}

function SelectPopup({ options }: { options: Array<string | SelectOption> }) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        className="bg-raised shadow-pop animate-fade z-110 min-w-(--radix-select-trigger-width) rounded-md p-1.5"
      >
        <SelectPrimitive.Viewport className="flex flex-col gap-0.5">
          {normalizeOptions(options).map((o) => (
            <OptionItem key={o.value} option={o} />
          ))}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function Select({
  options = [],
  value,
  defaultValue,
  onChange,
  placeholder = "Selecionar",
  label,
  icon,
  size = "md",
  hint,
  error,
  disabled = false,
  name,
  required,
  id,
  className,
  style,
  ...aria
}: SelectProps) {
  const autoId = React.useId();
  const fid = id ?? autoId;
  const ids = fieldIds(fid, error, hint);
  return (
    <div className={cn("inline-flex min-w-0 flex-col gap-2", className)} style={style}>
      {label && <FieldLabel id={`${fid}-label`}>{label}</FieldLabel>}
      <SelectPrimitive.Root
        // Callers commonly pass `value={x || undefined}` for "no selection".
        // Radix treats undefined as uncontrolled, so the first real selection
        // flips uncontrolled→controlled and React warns. "" is the controlled
        // empty state — coerce only when the caller clearly intends controlled
        // (has onChange and no defaultValue); a true uncontrolled Select keeps
        // receiving undefined.
        value={value ?? (onChange && defaultValue === undefined ? "" : undefined)}
        defaultValue={defaultValue}
        onValueChange={onChange}
        disabled={disabled}
        name={name}
        required={required}
      >
        <SelectTrigger
          fid={fid}
          label={label}
          icon={icon}
          placeholder={placeholder}
          size={size}
          error={error}
          describedId={ids.describedId}
          aria={aria}
        />
        <SelectPopup options={options} />
      </SelectPrimitive.Root>
      <FieldNote id={ids.noteId} error={error} hint={hint} />
    </div>
  );
}

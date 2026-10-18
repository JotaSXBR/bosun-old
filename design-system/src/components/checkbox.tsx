"use client";

import { cn } from "@crm/design-system/lib/utils";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import * as React from "react";

import { Icon } from "./icon";

/** Square check (6px radius) — Verde sinal fill when checked. */
export interface CheckboxProps extends Omit<
  React.ComponentProps<typeof CheckboxPrimitive.Root>,
  "onChange" | "checked"
> {
  checked?: boolean;
  defaultChecked?: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
}

function CheckIndicator({ indeterminate }: { indeterminate: boolean }) {
  return (
    <CheckboxPrimitive.Indicator forceMount asChild>
      <Icon
        name={indeterminate ? "minus" : "check"}
        size={13}
        strokeWidth={2.5}
        className="duration-base ease-standard scale-0 transition-transform data-[state=checked]:scale-100 data-[state=indeterminate]:scale-100"
      />
    </CheckboxPrimitive.Indicator>
  );
}

export function Checkbox({
  checked,
  defaultChecked = false,
  indeterminate = false,
  onChange,
  label,
  description,
  disabled = false,
  name,
  id,
  required,
  className,
  ref,
  ...props
}: CheckboxProps) {
  const autoId = React.useId();
  const bid = id ?? autoId;
  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      id={bid}
      name={name}
      required={required}
      checked={indeterminate ? "indeterminate" : checked}
      defaultChecked={defaultChecked}
      disabled={disabled}
      onCheckedChange={(v) => onChange?.(v === "indeterminate" || v)}
      className={cn(
        "border-line-strong bg-sunken text-ink-on-signal duration-fast ease-standard focus-visible:shadow-focus data-[state=checked]:border-signal data-[state=checked]:bg-signal data-[state=indeterminate]:border-signal data-[state=indeterminate]:bg-signal inline-flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-2 transition-all outline-none",
        description && "mt-0.5",
        className,
      )}
      {...props}
    >
      <CheckIndicator indeterminate={indeterminate} />
    </CheckboxPrimitive.Root>
  );

  if (!label && !description) return box;

  // Radix renders a <button>, which is a labelable element — htmlFor works.
  return (
    <LabeledCheckbox bid={bid} label={label} description={description} disabled={disabled}>
      {box}
    </LabeledCheckbox>
  );
}

function LabeledCheckbox({
  bid,
  label,
  description,
  disabled,
  children,
}: {
  bid: string;
  label?: React.ReactNode;
  description?: React.ReactNode;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 select-none",
        description && "items-start",
        disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
      )}
    >
      {children}
      <span className="flex flex-col gap-0.5">
        {label && (
          <label htmlFor={bid} className="text-ink-strong cursor-pointer text-sm">
            {label}
          </label>
        )}
        {description && <span className="text-ink-muted text-xs">{description}</span>}
      </span>
    </span>
  );
}

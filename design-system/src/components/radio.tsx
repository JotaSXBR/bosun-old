"use client";

import { cn } from "@crm/design-system/lib/utils";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import * as React from "react";

export interface RadioOption {
  value: string;
  label: React.ReactNode;
  description?: React.ReactNode;
}

/** Radio group — single choice among 2–5 visible options. */
export interface RadioProps extends Omit<
  React.ComponentProps<typeof RadioGroupPrimitive.Root>,
  "onChange" | "value" | "defaultValue"
> {
  options: Array<string | RadioOption>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Group label for assistive tech and the posted form field name. */
  name?: string;
  /** @default "column" */
  direction?: "row" | "column";
}

function RadioRow({
  o,
  name,
  disabled,
}: {
  o: RadioOption;
  name: string | undefined;
  disabled: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2.5 select-none",
        o.description && "items-start",
        disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
      )}
    >
      <RadioGroupPrimitive.Item
        value={o.value}
        id={name ? `${name}-${o.value}` : undefined}
        disabled={disabled}
        className={cn(
          "border-line-strong bg-sunken duration-fast focus-visible:shadow-focus data-[state=checked]:border-signal inline-flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors outline-none",
          o.description && "mt-0.5",
        )}
      >
        <RadioGroupPrimitive.Indicator forceMount asChild>
          <span className="bg-signal duration-base ease-standard size-2 scale-0 rounded-full transition-transform data-[state=checked]:scale-100" />
        </RadioGroupPrimitive.Indicator>
      </RadioGroupPrimitive.Item>
      <span className="flex flex-col gap-0.5">
        <label
          htmlFor={name ? `${name}-${o.value}` : undefined}
          className="text-ink-strong cursor-pointer text-sm"
        >
          {o.label}
        </label>
        {o.description && <span className="text-ink-muted text-xs">{o.description}</span>}
      </span>
    </span>
  );
}

export function Radio({
  options = [],
  value,
  defaultValue,
  onChange,
  name,
  direction = "column",
  disabled = false,
  className,
  ...props
}: RadioProps) {
  const norm = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <RadioGroupPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onChange}
      name={name}
      aria-label={name}
      disabled={disabled}
      className={cn("flex", direction === "row" ? "flex-row gap-5" : "flex-col gap-3", className)}
      {...props}
    >
      {norm.map((o) => (
        <RadioRow key={o.value} o={o} name={name} disabled={disabled} />
      ))}
    </RadioGroupPrimitive.Root>
  );
}

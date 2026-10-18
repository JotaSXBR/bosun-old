"use client";

import { cn } from "@crm/design-system/lib/utils";
import { Switch as SwitchPrimitive } from "radix-ui";
import * as React from "react";

/**
 * On/off toggle that applies immediately (automations, notifications,
 * integrations).
 */
export interface SwitchProps extends Omit<
  React.ComponentProps<typeof SwitchPrimitive.Root>,
  "onChange" | "onCheckedChange"
> {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  /** @default "md" */
  size?: "sm" | "md";
}

export function Switch({
  checked,
  defaultChecked = false,
  onChange,
  label,
  description,
  size = "md",
  disabled = false,
  name,
  id,
  className,
  ref,
  ...props
}: SwitchProps) {
  const autoId = React.useId();
  const bid = id ?? autoId;
  const control = (
    <SwitchPrimitive.Root
      ref={ref}
      id={bid}
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onChange}
      disabled={disabled}
      className={cn(
        "bg-raised-2 ring-line duration-base ease-standard focus-visible:shadow-focus data-[state=checked]:bg-signal relative shrink-0 cursor-pointer rounded-full p-0 ring-1 transition-all outline-none ring-inset data-[state=checked]:ring-transparent",
        size === "sm" ? "h-4.5 w-7.5" : "h-5.5 w-9.5",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "bg-steel-300 duration-base ease-standard data-[state=checked]:bg-abyss-900 absolute top-0.75 left-0.75 block rounded-full transition-all",
          size === "sm"
            ? "size-3 data-[state=checked]:translate-x-3"
            : "size-4 data-[state=checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );

  if (!label && !description) return control;

  return (
    <LabeledSwitch bid={bid} label={label} description={description} disabled={disabled}>
      {control}
    </LabeledSwitch>
  );
}

function LabeledSwitch({
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
        "inline-flex items-center gap-3 select-none",
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

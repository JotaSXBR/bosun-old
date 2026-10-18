"use client";

import { cn } from "@crm/design-system/lib/utils";
import { Tabs as TabsPrimitive } from "radix-ui";
import * as React from "react";

export interface TabItem {
  value: string;
  label: React.ReactNode;
  count?: number;
}

/** In-page view switcher — underline (page sections) or pill (compact segmented). */
export interface TabsProps extends Omit<
  React.ComponentProps<typeof TabsPrimitive.Root>,
  "onChange" | "onValueChange"
> {
  items: Array<string | TabItem>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** @default "underline" */
  variant?: "underline" | "pill";
}

function TabTrigger({ o, pill }: { o: TabItem; pill: boolean }) {
  return (
    <TabsPrimitive.Trigger
      value={o.value}
      className={cn(
        "duration-fast ease-standard focus-visible:shadow-focus relative inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent font-sans whitespace-nowrap transition-all outline-none",
        pill
          ? "rounded-pill text-ui text-ink-muted data-[state=active]:bg-raised-2 data-[state=active]:text-ink-strong data-[state=active]:shadow-control h-8 px-3.5 font-medium"
          : "text-ui-lg text-ink-muted data-[state=active]:text-ink-strong h-9 px-0 pb-2.5 data-[state=active]:font-medium",
      )}
    >
      {o.label}
      {o.count != null && (
        <span className="text-2xs text-ink-subtle in-data-[state=active]:text-ink-accent tabular-nums">
          {o.count}
        </span>
      )}
      {!pill && (
        <span
          aria-hidden="true"
          className="duration-base absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-current opacity-0 transition-opacity in-data-[state=active]:opacity-100"
        />
      )}
    </TabsPrimitive.Trigger>
  );
}

export function Tabs({
  items = [],
  value,
  defaultValue,
  onChange,
  variant = "underline",
  className,
  ...props
}: TabsProps) {
  const norm = items.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const pill = variant === "pill";
  return (
    <TabsPrimitive.Root
      value={value}
      defaultValue={defaultValue ?? norm[0]?.value}
      onValueChange={onChange}
      className={className}
      {...props}
    >
      <TabsPrimitive.List
        className={cn(
          "flex w-fit items-center",
          pill ? "rounded-pill border-line-subtle bg-control gap-0.5 border p-1" : "gap-8",
        )}
      >
        {norm.map((o) => (
          <TabTrigger key={o.value} o={o} pill={pill} />
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

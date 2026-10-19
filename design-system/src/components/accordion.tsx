"use client";

import { cn } from "@crm/design-system/lib/utils";
import { Accordion as AccordionPrimitive } from "radix-ui";
import * as React from "react";

import { Icon } from "./icon";

export interface AccordionItem {
  id: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  content: React.ReactNode;
}

/** Collapsible list; the open item lifts onto a raised inner card. */
export interface AccordionProps {
  items: AccordionItem[];
  /** Id(s) open initially. Defaults to the first item. */
  defaultOpen?: string | string[];
  /** Allow several open at once. @default false */
  multiple?: boolean;
  className?: string;
}

function AccordionRow({ it }: { it: AccordionItem }) {
  return (
    <AccordionPrimitive.Item
      value={it.id}
      className="rounded-card-inner duration-base ease-standard data-[state=open]:bg-raised data-[state=open]:shadow-card transition-all"
    >
      <AccordionPrimitive.Header asChild>
        <AccordionPrimitive.Trigger
          className={cn(
            "group focus-visible:shadow-focus flex w-full cursor-pointer items-center gap-3 border-0 bg-transparent pr-3.5 pl-4.5 text-left outline-none",
            "py-2.5 in-data-[state=open]:pt-3.5 in-data-[state=open]:pb-1.5",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="font-display text-ink duration-fast group-data-[state=open]:text-ink-strong tracking-card block text-lg font-medium transition-colors">
              {it.title}
            </span>
            {it.meta && <span className="text-ink-muted mt-0.5 block text-xs">{it.meta}</span>}
          </span>
          <Icon
            name="chevron-down"
            size={16}
            className="text-icon-muted duration-base ease-standard group-data-[state=open]:text-icon-strong transition-transform group-data-[state=open]:rotate-180"
          />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="overflow-hidden">
        <div className="px-4.5 pt-1.5 pb-4.5">{it.content}</div>
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}

export function Accordion({
  items = [],
  defaultOpen,
  multiple = false,
  className,
}: AccordionProps) {
  const fallback = defaultOpen ?? items[0]?.id;
  const defaultValue = (Array.isArray(fallback) ? fallback : [fallback]).filter(
    Boolean,
  ) as string[];

  const itemList = items.map((it) => <AccordionRow key={it.id} it={it} />);

  const cls = cn("flex flex-col gap-1.5", className);
  return multiple ? (
    <AccordionPrimitive.Root type="multiple" defaultValue={defaultValue} className={cls}>
      {itemList}
    </AccordionPrimitive.Root>
  ) : (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      defaultValue={defaultValue[0]}
      className={cls}
    >
      {itemList}
    </AccordionPrimitive.Root>
  );
}

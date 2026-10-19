"use client";

import { cn } from "@crm/design-system/lib/utils";
import * as React from "react";

import { TooltipBubble } from "./tooltip";

export interface BarDatum {
  label: string;
  value: number;
  /** Planned total; the gap above value is hatched. */
  target?: number;
}

/**
 * Capsule column chart: solid = actual, hatched cap = remaining to target; the
 * focused column turns dotted Verde sinal with a pinned value.
 */
export interface BarChartProps extends Omit<React.ComponentProps<"div">, "defaultValue"> {
  data: BarDatum[];
  /** Chart area height in px. @default 220 */
  height?: number;
  /** Controlled highlighted index. Defaults to the max value. */
  highlight?: number;
  defaultHighlight?: number;
  onHighlight?: (index: number) => void;
  /** Formats the pinned tooltip value. */
  formatValue?: (value: number, datum: BarDatum) => React.ReactNode;
  /** @default 72 */
  maxBarWidth?: number;
}

function Bar({
  d,
  on,
  max,
  usable,
  maxBarWidth,
  formatValue,
  onEnter,
}: {
  d: BarDatum;
  on: boolean;
  max: number;
  usable: number;
  maxBarWidth: number;
  formatValue: NonNullable<BarChartProps["formatValue"]>;
  onEnter: () => void;
}) {
  const vh = Math.max(18, (d.value / max) * usable);
  const th =
    d.target && d.target > d.value ? Math.max(18, ((d.target - d.value) / max) * usable) : 0;
  return (
    <div
      onMouseEnter={onEnter}
      className="relative flex h-full max-w-(--bar-w) flex-1 cursor-default flex-col justify-end gap-1"
      style={{ "--bar-w": `${maxBarWidth}px` } as React.CSSProperties}
    >
      {on && (
        <div className="mb-0.5 flex justify-center">
          <TooltipBubble tone="accent" stem={12}>
            {formatValue(d.value, d)}
          </TooltipBubble>
        </div>
      )}
      {th > 0 && (
        <div
          className={cn("bx-hatch bg-raised-2/45 h-(--bar-h) rounded-lg", !on && "opacity-85")}
          style={{ "--bar-h": `${th}px` } as React.CSSProperties}
        />
      )}
      <div
        className={cn(
          "duration-chart ease-standard h-(--bar-h) rounded-lg transition-all",
          on ? "bx-dots bx-on-accent bg-data-1" : "bg-raised-2",
        )}
        style={{ "--bar-h": `${vh}px` } as React.CSSProperties}
      />
    </div>
  );
}

function BarLabels({
  data,
  hi,
  maxBarWidth,
}: {
  data: BarDatum[];
  hi: number;
  maxBarWidth: number;
}) {
  return (
    <div className="flex gap-2.5">
      {data.map((d, i) => (
        <div
          key={i}
          className="flex max-w-(--bar-w) flex-1 justify-center"
          style={{ "--bar-w": `${maxBarWidth}px` } as React.CSSProperties}
        >
          <span
            className={cn(
              "inline-flex h-6 items-center rounded-full px-2 text-xs",
              i === hi ? "bg-raised-2 text-ink-strong" : "text-ink-muted",
            )}
          >
            {d.label}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BarChart({
  data = [],
  height = 220,
  highlight,
  defaultHighlight,
  onHighlight,
  formatValue = (v) => v,
  maxBarWidth = 72,
  className,
  ref,
  ...props
}: BarChartProps) {
  const [inner, setInner] = React.useState(
    () =>
      defaultHighlight ??
      data.reduce((m, d, i) => (d.value > (data[m]?.value ?? -Infinity) ? i : m), 0),
  );
  const hi = highlight ?? inner;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.target ?? 0)));
  const usable = height - 44;
  return (
    <div ref={ref} className={cn("flex min-w-0 flex-col gap-3", className)} {...props}>
      <div
        className="flex h-(--chart-h) items-end gap-2.5"
        style={{ "--chart-h": `${height}px` } as React.CSSProperties}
      >
        {data.map((d, i) => (
          <Bar
            key={i}
            d={d}
            on={i === hi}
            max={max}
            usable={usable}
            maxBarWidth={maxBarWidth}
            formatValue={formatValue}
            onEnter={() => {
              setInner(i);
              onHighlight?.(i);
            }}
          />
        ))}
      </div>
      <BarLabels data={data} hi={hi} maxBarWidth={maxBarWidth} />
    </div>
  );
}

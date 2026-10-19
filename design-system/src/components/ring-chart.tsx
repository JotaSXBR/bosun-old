import { cn } from "@crm/design-system/lib/utils";
import * as React from "react";

export interface RingSegment {
  value: number;
  color?: string;
  label?: string;
  /** Override the chip text. */
  display?: React.ReactNode;
}

const DATA_COLORS = ["var(--data-1)", "var(--data-2)", "var(--data-3)", "var(--data-4)"];

/** Segmented donut with rounded caps and gaps between segments. */
export interface RingChartProps extends React.ComponentProps<"div"> {
  segments: RingSegment[];
  /** @default 140 */
  size?: number;
  /** @default 18 */
  thickness?: number;
  /** Degrees between segments. @default 14 */
  gap?: number;
  /** Small value chips at each segment start. @default true */
  showValues?: boolean;
  /** Center content. */
  children?: React.ReactNode;
}

function ringArcs({
  segments,
  size,
  thickness,
  gap,
}: {
  segments: RingSegment[];
  size: number;
  thickness: number;
  gap: number;
}) {
  const r = (size - thickness) / 2 - 8;
  const C = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const usable = 360 - gap * segments.length;
  const capDeg = (thickness / C) * 360;
  let angle = -210;
  const arcs = segments.map((s, i) => {
    const sweep = (s.value / total) * usable;
    const start = angle;
    angle += sweep + gap;
    const dash = Math.max(0.01, ((sweep - capDeg) / 360) * C);
    return { ...s, start, dash, color: s.color ?? DATA_COLORS[i % 4] };
  });
  return { r, C, capDeg, arcs };
}

function RingSvg({
  size,
  thickness,
  geometry: { r, C, capDeg, arcs },
}: {
  size: number;
  thickness: number;
  geometry: ReturnType<typeof ringArcs>;
}) {
  const cx = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      <circle
        cx={cx}
        cy={cx}
        r={r}
        fill="none"
        stroke="var(--data-track)"
        strokeWidth={thickness * 0.35}
      />
      {arcs.map((a, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cx}
          r={r}
          fill="none"
          stroke={a.color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${a.dash} ${C}`}
          transform={`rotate(${a.start + capDeg / 2} ${cx} ${cx})`}
          className="duration-chart ease-standard transition-[stroke-dasharray]"
        />
      ))}
    </svg>
  );
}

function ValueChips({
  size,
  thickness,
  geometry: { r, arcs },
}: {
  size: number;
  thickness: number;
  geometry: ReturnType<typeof ringArcs>;
}) {
  const cx = size / 2;
  return arcs.map((a, i) => {
    const rad = (a.start * Math.PI) / 180;
    const x = cx + Math.cos(rad) * (r + thickness / 2 + 4);
    const y = cx + Math.sin(rad) * (r + thickness / 2 + 4);
    return (
      <span
        key={i}
        className="bg-raised-2 text-2xs text-ink-strong ring-surface absolute top-(--chip-y) left-(--chip-x) inline-flex h-5 min-w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full px-1.5 font-medium tabular-nums ring-4"
        style={{ "--chip-x": `${x}px`, "--chip-y": `${y}px` } as React.CSSProperties}
      >
        {a.display ?? a.value}
      </span>
    );
  });
}

export function RingChart({
  segments = [],
  size = 140,
  thickness = 18,
  gap = 14,
  showValues = true,
  children,
  className,
  style,
  ref,
  ...props
}: RingChartProps) {
  const geometry = ringArcs({ segments, size, thickness, gap });
  return (
    <div
      ref={ref}
      className={cn("relative size-(--ring-d) shrink-0", className)}
      style={{ "--ring-d": `${size}px`, ...style } as React.CSSProperties}
      {...props}
    >
      <RingSvg size={size} thickness={thickness} geometry={geometry} />
      {showValues && <ValueChips size={size} thickness={thickness} geometry={geometry} />}
      {children && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          {children}
        </div>
      )}
    </div>
  );
}

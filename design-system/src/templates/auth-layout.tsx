import type * as React from "react";

import { Wordmark } from "../components/wordmark";

/** Brand node on the left panel motif: [x%, y%, dotColor]. */
const NODES: Array<[number, number, string]> = [
  [14, 44, "var(--signal-400)"],
  [40, 24, "var(--mist)"],
  [72, 36, "var(--ocean-300)"],
  [54, 56, "var(--steel-400)"],
];

/**
 * Two-column auth shell — brand panel with the node motif on the left (`lg+`),
 * form on the right. Used by sign-in, sign-up and onboarding.
 */
export interface AuthLayoutProps {
  children: React.ReactNode;
  /** Light lead line of the headline. @default "Você define o rumo." */
  lead?: string;
  /** Emphasized payoff line. @default "BOSUN organiza a operação." */
  payoff?: string;
  /** Node labels, left→right. @default ["Atendimento","Negócios","Integrações","Automações"] */
  nodes?: [string, string, string, string];
}

function BrandPanel({
  lead,
  payoff,
  nodes,
}: Required<Pick<AuthLayoutProps, "lead" | "payoff" | "nodes">>) {
  return (
    <div className="bx-grid bg-sunken relative hidden flex-col overflow-hidden rounded-2xl p-12 lg:flex">
      <Wordmark size={24} />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        aria-hidden
      >
        <path
          d="M14 44 C 22 26, 32 22, 40 24 S 62 40, 72 36 M40 24 C 46 40, 50 50, 54 56"
          fill="none"
          stroke="var(--steel-600)"
          strokeDasharray="0.12 0.9"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          strokeWidth={1.5}
        />
      </svg>
      {NODES.map(([x, y, color], i) => (
        <div
          key={i}
          className="absolute top-(--node-y) left-(--node-x) flex -translate-x-2 -translate-y-1/2 items-center gap-2.5"
          style={{ "--node-x": `${x}%`, "--node-y": `${y}%` } as React.CSSProperties}
        >
          <span
            className="shadow-halo size-4 rounded-full bg-(--node-c)"
            style={{ "--node-c": color } as React.CSSProperties}
            aria-hidden
          />
          <span className="bg-raised text-ink-strong rounded-pill px-3 py-1.5 text-sm font-medium">
            {nodes[i]}
          </span>
        </div>
      ))}
      <div className="relative mt-auto max-w-140">
        <div className="font-display text-h1 tracking-display">
          <span className="text-ink-muted font-light">{lead}</span>
          <br />
          <span className="text-ink-strong font-semibold">{payoff}</span>
        </div>
      </div>
    </div>
  );
}

export function AuthLayout({
  children,
  lead = "Você define o rumo.",
  payoff = "BOSUN organiza a operação.",
  nodes = ["Atendimento", "Negócios", "Integrações", "Automações"],
}: AuthLayoutProps) {
  return (
    <div className="grid min-h-screen gap-4 p-4 lg:grid-cols-2">
      <BrandPanel lead={lead} payoff={payoff} nodes={nodes} />
      <main className="flex items-center justify-center p-8">
        <div className="w-full max-w-100">
          <div className="mb-8 lg:hidden">
            <Wordmark size={24} />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

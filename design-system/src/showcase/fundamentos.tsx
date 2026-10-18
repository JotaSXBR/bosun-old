import { cn } from "@crm/design-system/lib/utils";
import type * as React from "react";

import { Icon, iconNames } from "../components/icon";
import { Wordmark } from "../components/wordmark";
import { eyebrow, Group, Labeled, Row, Section } from "./helpers";

const COLOR_GROUPS: Array<{ label: string; tokens: string[] }> = [
  {
    label: "Superfícies",
    tokens: [
      "bg-page",
      "bg-sunken",
      "surface-card",
      "surface-raised",
      "surface-raised-2",
      "surface-control",
      "surface-control-hover",
      "surface-control-active",
      "surface-inverse",
      "surface-accent",
      "surface-accent-hover",
      "surface-accent-soft",
      "surface-overlay",
    ],
  },
  {
    label: "Tinta",
    tokens: [
      "text-strong",
      "text-body",
      "text-muted",
      "text-subtle",
      "text-accent",
      "text-on-accent",
      "text-on-accent-muted",
      "text-inverse",
      "text-disabled",
    ],
  },
  {
    label: "Linhas & ícones",
    tokens: [
      "border-subtle",
      "border-default",
      "border-strong",
      "border-accent",
      "icon-default",
      "icon-strong",
      "icon-muted",
    ],
  },
  {
    label: "Status & dados",
    tokens: [
      "status-success",
      "status-success-bg",
      "status-warning",
      "status-warning-bg",
      "status-danger",
      "status-danger-bg",
      "status-info",
      "status-info-bg",
      "status-running",
      "status-running-bg",
      "data-1",
      "data-2",
      "data-3",
      "data-4",
      "data-5",
      "data-track",
    ],
  },
];

const TYPE_ROWS: Array<{ label: string; cls: string; sample: string }> = [
  { label: "display-xl", cls: "font-display font-semibold text-display-xl", sample: "Bosun" },
  { label: "display", cls: "font-display font-semibold text-display", sample: "Bosun" },
  { label: "h1", cls: "font-display font-semibold text-h1", sample: "Seu mundo digital" },
  { label: "page-title", cls: "font-display font-semibold text-page-title", sample: "Início" },
  { label: "h2", cls: "font-display font-semibold text-h2", sample: "Atendimento" },
  { label: "h3", cls: "font-display font-semibold text-h3", sample: "Negócios" },
  { label: "h4", cls: "font-display font-medium text-h4", sample: "Integrações" },
  { label: "card-title", cls: "font-display font-medium text-lg", sample: "Fluxo de boas-vindas" },
  { label: "body-lg", cls: "text-lg", sample: "Resumo da semana em leitura confortável." },
  { label: "body-md", cls: "text-md", sample: "Texto de interface padrão para leitura." },
  // eslint-disable-next-line no-restricted-syntax -- sample copy describes the px size, not styling
  { label: "body-sm", cls: "text-sm", sample: "O tamanho de trabalho da interface: 14px." },
  { label: "label-lg", cls: "text-ui-lg font-medium tracking-ui", sample: "Ação primária" },
  { label: "label-md", cls: "text-sm font-medium tracking-ui", sample: "Botão padrão" },
  { label: "label-sm", cls: "text-ui font-medium tracking-ui", sample: "Controle compacto" },
  { label: "caption", cls: "text-xs", sample: "Legenda e metadados." },
  { label: "micro", cls: "text-2xs font-medium", sample: "Rótulos mínimos e chips." },
  { label: "eyebrow", cls: eyebrow, sample: "seção · contexto" },
  { label: "mono", cls: "font-mono text-ui leading-mono", sample: "run_8f2e · 08:00:14" },
  {
    label: "metric-xl",
    cls: "font-display font-light text-metric-xl tracking-display",
    sample: "99,1%",
  },
  {
    label: "metric",
    cls: "font-display font-light text-metric tracking-display",
    sample: "R$ 12,4k",
  },
  {
    label: "metric-sm",
    cls: "font-display font-light text-metric-sm tracking-display",
    sample: "1.284",
  },
];

const RADIUS_ROWS = [
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
  "pill",
  "card",
  "card-inner",
  "notch",
] as const;

const SHADOW_ROWS = [
  "control",
  "card",
  "raised",
  "pop",
  "glow",
  "focus",
  "halo",
  "bubble",
] as const;

function CoresSection() {
  return (
    <Section title="Cores">
      {COLOR_GROUPS.map((g) => (
        <Group key={g.label} title={g.label}>
          <Row>
            {g.tokens.map((t) => (
              <Labeled key={t} label={`--${t}`}>
                <span
                  className="ring-line-subtle inline-block size-10 rounded-xs bg-(--swatch) ring-1 ring-inset"
                  style={{ "--swatch": `var(--${t})` } as React.CSSProperties}
                />
              </Labeled>
            ))}
          </Row>
        </Group>
      ))}
    </Section>
  );
}

function TipografiaSection() {
  return (
    <Section title="Tipografia">
      <div className="flex flex-col gap-4">
        {TYPE_ROWS.map((t) => (
          <div key={t.label} className="flex items-baseline gap-6">
            <span className={cn(eyebrow, "w-24 shrink-0")}>{t.label}</span>
            <span className={cn(t.cls, "text-ink")}>{t.sample}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function RaiosSection() {
  return (
    <Section title="Raios">
      <Row>
        {RADIUS_ROWS.map((r) => (
          <Labeled key={r} label={r}>
            <span
              className="bg-raised-2 inline-block size-14 rounded-(--r)"
              style={{ "--r": `var(--radius-${r})` } as React.CSSProperties}
            />
          </Labeled>
        ))}
      </Row>
    </Section>
  );
}

function SombrasSection() {
  return (
    <Section title="Sombras">
      <Row>
        {SHADOW_ROWS.map((s) => (
          <Labeled key={s} label={s}>
            <span
              className="bg-surface inline-block size-14 rounded-md shadow-(--s)"
              style={{ "--s": `var(--shadow-${s})` } as React.CSSProperties}
            />
          </Labeled>
        ))}
      </Row>
    </Section>
  );
}

function PadroesSection() {
  return (
    <Section title="Padrões">
      <Row>
        {(["bx-hatch", "bx-hatch-h", "bx-dots", "bx-grid"] as const).map((p) => (
          <Labeled key={p} label={p}>
            <span className={cn("bg-surface inline-block h-24 w-40 rounded-md", p)} />
          </Labeled>
        ))}
        <Labeled label="bx-on-accent">
          <span className="bx-dots bx-on-accent bg-signal inline-flex h-24 w-40 items-center justify-center rounded-md">
            <span className="text-ui text-ink-on-signal font-medium">accent</span>
          </span>
        </Labeled>
      </Row>
    </Section>
  );
}

function IconesSection() {
  return (
    <Section title="Ícones">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
        {iconNames.map((n) => (
          <div
            key={n}
            className="text-icon hover:bg-raised flex flex-col items-center gap-1.5 rounded-sm px-1 py-2"
          >
            <Icon name={n} size={20} />
            <span className="text-2xs text-ink-subtle max-w-full truncate font-mono">{n}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function WordmarkSection() {
  return (
    <Section title="Wordmark">
      <Row>
        <Wordmark size="sm" />
        <Wordmark size="md" />
        <Wordmark size="lg" />
        <Wordmark size="md" tone="accent" tagline />
      </Row>
    </Section>
  );
}

export function Fundamentos() {
  return (
    <>
      <CoresSection />

      <TipografiaSection />

      <RaiosSection />

      <SombrasSection />

      <PadroesSection />

      <IconesSection />

      <WordmarkSection />
    </>
  );
}

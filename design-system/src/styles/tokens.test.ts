import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Drift test: DESIGN.md (repo root) is the normative token source; the CSS in
 * ./tokens implements it. Any divergence fails here — fix the CSS or the
 * DESIGN.md front matter, never silently.
 */

const designMd = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");
const lines = designMd.split("\n");
if (lines[0]?.trim() !== "---") throw new Error("DESIGN.md must start with YAML front matter");
const fmEnd = lines.indexOf("---", 1);
const doc = parse(lines.slice(1, fmEnd).join("\n")) as Record<string, Record<string, unknown>>;

function resolveRef(value: unknown, depth = 0): unknown {
  if (depth > 10 || typeof value !== "string") return value;
  const m = /^\{([a-z]+)\.([\w-]+)\}$/.exec(value.trim());
  if (!m) return value;
  return resolveRef(doc[m[1]!]?.[m[2]!], depth + 1);
}

type Scope = "root" | "dark" | "light";
type ScopeVars = Record<Scope, Record<string, string>>;

const scopeOf = (sel: string): Scope | null =>
  sel === ":root"
    ? "root"
    : sel === '[data-theme="dark"]'
      ? "dark"
      : sel === '[data-theme="light"]'
        ? "light"
        : null;

const TOKEN_FILES = ["colors", "typography", "spacing", "effects", "extensions"] as const;
const fileScopes = {} as Record<(typeof TOKEN_FILES)[number], ScopeVars>;
for (const file of TOKEN_FILES) {
  const scopes: ScopeVars = { root: {}, dark: {}, light: {} };
  const css = readFileSync(new URL(`./tokens/${file}.css`, import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const rawSel of block[1]!.split(",")) {
      const scope = scopeOf(rawSel.trim());
      if (!scope) continue;
      for (const decl of block[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        scopes[scope][decl[1]!] = decl[2]!.trim();
      }
    }
  }
  fileScopes[file] = scopes;
}

/** Resolve var(--x) chains: same scope first, :root fallback. */
function resolveVar(
  name: string,
  scope: Scope = "root",
  file?: (typeof TOKEN_FILES)[number],
): string {
  const scopes = file ? fileScopes[file] : mergedScopes;
  let value = scopes[scope][name] ?? scopes.root[name] ?? "";
  for (let i = 0; i < 10 && value.includes("var(--"); i++) {
    value = value.replace(
      /var\((--[\w-]+)\)/g,
      (_m, n: string) => scopes[scope][n] ?? scopes.root[n] ?? "",
    );
  }
  return value;
}

const mergedScopes: ScopeVars = { root: {}, dark: {}, light: {} };
for (const file of TOKEN_FILES) {
  for (const scope of ["root", "dark", "light"] as const) {
    Object.assign(mergedScopes[scope], fileScopes[file][scope]);
  }
}

/** lowercase · strip whitespace · leading-dot decimals → 0-prefixed. */
const norm = (v: unknown) =>
  String(v)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(?<![\d.])\.(\d)/g, "0.$1");

const cssValue = (name: string, scope: Scope = "root") => norm(resolveVar(name, scope));
const docValue = (v: unknown) => norm(resolveRef(v));

const colors = doc.colors as Record<string, string>;
const ROLE_KEYS = new Set([
  "primary",
  "secondary",
  "tertiary",
  "neutral",
  "surface",
  "on-surface",
  "error",
]);

describe("colors", () => {
  it("every dark key (except roles) is a :root custom property with the same value", () => {
    for (const key of Object.keys(colors)) {
      if (key.startsWith("light-") || ROLE_KEYS.has(key)) continue;
      expect(cssValue(`--${key}`), `colors.${key}`).toBe(docValue(colors[key]));
    }
  });

  it("every light-* key is the light-scope value of the same token", () => {
    for (const key of Object.keys(colors)) {
      if (!key.startsWith("light-")) continue;
      const bare = key.slice("light-".length);
      expect(cssValue(`--${bare}`, "light"), `colors.${key}`).toBe(docValue(colors[key]));
    }
  });

  it("colors.css declares no undeclared tokens; dark scope mirrors :root", () => {
    const cc = fileScopes.colors;
    for (const prop of Object.keys(cc.root)) {
      expect(colors, `colors.css :root ${prop}`).toHaveProperty(prop.slice(2));
    }
    for (const prop of Object.keys(cc.light)) {
      expect(colors, `colors.css [light] ${prop}`).toHaveProperty(`light-${prop.slice(2)}`);
    }
    for (const prop of Object.keys(cc.dark)) {
      expect(norm(resolveVar(prop, "dark", "colors")), `colors.css [dark] ${prop} == :root`).toBe(
        norm(resolveVar(prop, "root", "colors")),
      );
    }
  });
});

describe("rounded", () => {
  const rounded = doc.rounded as Record<string, string>;
  it("each key maps to --radius-<key> (full → --radius-pill)", () => {
    for (const key of Object.keys(rounded)) {
      const token = key === "full" ? "--radius-pill" : `--radius-${key}`;
      expect(cssValue(token), `rounded.${key}`).toBe(docValue(rounded[key]));
    }
  });
});

describe("spacing", () => {
  const spacing = doc.spacing as Record<string, string | number>;
  const isNumericKey = (key: string) =>
    key.split("-").every((part) => part !== "" && /^\d+$/.test(part));
  it("numeric keys map to --space-<key>", () => {
    for (const key of Object.keys(spacing)) {
      if (!isNumericKey(key)) continue;
      expect(cssValue(`--space-${key}`), `spacing.${key}`).toBe(docValue(spacing[key]));
    }
  });
  it("base equals 4px and --space-1", () => {
    expect(docValue(spacing.base)).toBe("4px");
    expect(cssValue("--space-1")).toBe(docValue(spacing.base));
  });
  it("named keys map to --<key>", () => {
    for (const key of Object.keys(spacing)) {
      if (key === "base" || isNumericKey(key)) continue;
      expect(cssValue(`--${key}`), `spacing.${key}`).toBe(docValue(spacing[key]));
    }
  });
});

describe("typography", () => {
  const typography = doc.typography as Record<
    string,
    { fontFamily: string; fontSize: string; lineHeight?: number; letterSpacing?: string }
  >;

  const MAP: Record<string, { size?: string; leading?: string; tracking?: string }> = {
    "display-xl": {
      size: "--text-display-xl",
      leading: "--leading-display-xl",
      tracking: "--tracking-display",
    },
    display: {
      size: "--text-display",
      leading: "--leading-display",
      tracking: "--tracking-display",
    },
    h1: { size: "--text-h1", leading: "--leading-h1", tracking: "--tracking-heading" },
    h2: { size: "--text-h2", leading: "--leading-h2", tracking: "--tracking-heading" },
    h3: { size: "--text-h3", leading: "--leading-h3", tracking: "--tracking-heading" },
    h4: { size: "--text-h4", leading: "--leading-h4", tracking: "--tracking-heading" },
    "page-title": {
      size: "--text-page-title",
      leading: "--leading-page-title",
      tracking: "--tracking-title",
    },
    "card-title": { size: "--text-lg", tracking: "--tracking-card" },
    "metric-unit": { size: "--text-unit" },
    wordmark: { tracking: "--tracking-wordmark" },
    "body-lg": { size: "--text-lg", leading: "--leading-lg" },
    "body-md": { size: "--text-md", leading: "--leading-md" },
    "body-sm": { size: "--text-sm", leading: "--leading-sm" },
    "label-lg": { size: "--text-ui-lg", tracking: "--tracking-ui" },
    "label-md": { size: "--text-sm", tracking: "--tracking-ui" },
    "label-sm": { size: "--text-ui", leading: "--leading-ui", tracking: "--tracking-ui" },
    caption: { size: "--text-xs", leading: "--leading-xs" },
    micro: { size: "--text-2xs", leading: "--leading-2xs" },
    eyebrow: { size: "--text-2xs", tracking: "--tracking-eyebrow" },
    mono: { size: "--text-ui", leading: "--leading-mono" },
    "metric-xl": { size: "--text-metric-xl", tracking: "--tracking-display" },
    metric: { size: "--text-metric", tracking: "--tracking-display" },
    "metric-sm": { size: "--text-metric-sm", tracking: "--tracking-display" },
  };

  it("every documented level maps to its tokens", () => {
    for (const key of Object.keys(typography)) {
      const map = MAP[key];
      expect(map, `typography.${key} has no token mapping`).toBeDefined();
      if (!map) continue;
      const level = typography[key]!;
      const checks: [label: string, token: string | undefined, documented: unknown][] = [
        [`typography.${key}.fontSize`, map.size, level.fontSize],
        [`typography.${key}.lineHeight`, map.leading, level.lineHeight],
        [`typography.${key}.letterSpacing`, map.tracking, level.letterSpacing],
      ];
      for (const [label, token, documented] of checks.filter(([, t]) => t)) {
        expect(cssValue(token!), label).toBe(docValue(documented));
      }
    }
  });

  it("families are Manrope/Inter/JetBrains Mono and wired to --font-*", () => {
    const fonts = ["--font-display", "--font-sans", "--font-mono"].map((n) =>
      resolveVar(n, "root", "typography"),
    );
    for (const [key, level] of Object.entries(typography)) {
      expect(["Manrope", "Inter", "JetBrains Mono"], `typography.${key}.fontFamily`).toContain(
        level.fontFamily,
      );
      expect(
        fonts.some((f) => f.includes(level.fontFamily)),
        `typography.${key}.fontFamily "${level.fontFamily}" in --font-*`,
      ).toBe(true);
    }
  });
});

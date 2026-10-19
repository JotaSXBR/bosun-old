# Code Quality Standard

This document is the quality bar for the monorepo. **Section 1** defines
the industry-established standard for this stack, derived from external
documentation only (each row cites its source and the date it was read,
2026-10-10). **Section 2** records how this repo's tooling compares and
what was adopted, rejected, or deferred — written after the diff and the
violation measurement.

Stack measured from installed packages: ESLint 9.39 + flat config,
typescript-eslint 8.71, Prettier 3.9, TypeScript 6.0, Next 16.3, React 19,
Vitest 5, Playwright 1.63, drizzle-orm 0.45, pnpm + Turborepo, lefthook 2.

## 1. The standard (external sources only)

### 1.1 Linter and formatter

| Practice                                                                                                                                | Source                                                                                          | Decision                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One linter: ESLint 9 flat config. One formatter: Prettier. Lint owns code quality; Prettier owns formatting.                            | https://prettier.io/docs/integrating-with-linters                                               | Adopt. Official division of responsibility.                                                                                                                                                                           |
| `eslint-config-prettier` to disable lint rules that conflict with Prettier                                                              | https://prettier.io/docs/integrating-with-linters                                               | Adopt. Canonical mechanism.                                                                                                                                                                                           |
| `eslint-plugin-prettier` (Prettier-as-rule)                                                                                             | https://prettier.io/docs/integrating-with-linters — "generally not recommended"                 | Reject. Officially discouraged: slow, noisy, extra indirection.                                                                                                                                                       |
| Second linter alongside ESLint (Biome/Oxlint)                                                                                           | https://biomejs.dev/linter/                                                                     | Reject. Biome is a full alternative, not an add-on; it does not cover the Next.js/react-hooks/jsx-a11y/drizzle/playwright/vitest plugin surface this stack needs. Running both duplicates lint without measured gain. |
| Next.js 16: `next lint` removed; lint via `eslint` CLI + `eslint-config-next/core-web-vitals` flat export; `next build` no longer lints | https://nextjs.org/docs (version-16 upgrade guide + config/eslint) — Context7 `/vercel/next.js` | Adopt as shipped. Lint is a CI step, not a build step.                                                                                                                                                                |
| `eslint-config-next` bundles react, react-hooks v7, jsx-a11y, import, @next/next, typescript-eslint                                     | https://github.com/vercel/next.js/blob/canary/packages/eslint-config-next/package.json          | Adopt for `apps/web` only — the a11y + hooks coverage comes free and is the vendor-supported path.                                                                                                                    |
| Shared flat config in one workspace package consumed by all projects                                                                    | typescript-eslint getting-started docs (Context7 `/typescript-eslint/typescript-eslint`)        | Adopt. Single source of lint truth; per-workspace configs only add what exists nowhere else (Next app, e2e, tests).                                                                                                   |

### 1.2 Type-aware linting

| Practice                                                                                                                                                                                                                                      | Source                                                                                                                                    | Decision                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tseslint.configs.recommendedTypeChecked` on all TS — "rules whose reports are almost always for a bad practice and/or likely bug"; includes `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unnecessary-type-assertion` | https://typescript-eslint.io/users/configs                                                                                                | Adopt, severity **error**. Baseline for typed projects.                                                                                                                                                                                             |
| `parserOptions.projectService: true` (+ `allowDefaultProject` for root JS files)                                                                                                                                                              | https://typescript-eslint.io/packages/parser — Context7                                                                                   | Adopt. Required for typed rules; auto-locates each file's tsconfig.                                                                                                                                                                                 |
| `tseslint.configs.stylisticTypeChecked`                                                                                                                                                                                                       | https://typescript-eslint.io/users/configs — "we suggest enabling … to start"                                                             | Adopt, but measured rule by rule: drop individual rules that are pure preference with high violation counts (e.g. `consistent-type-definitions`); keep `consistent-type-imports`/`prefer-nullish-coalescing`-class rules that prevent real defects. |
| `strict` / `strictTypeChecked`                                                                                                                                                                                                                | https://typescript-eslint.io/users/configs — "only if a nontrivial percentage of its developers are highly proficient"; not semver-stable | Not adopted wholesale. Candidate bug-catching strict rules may be promoted individually after measurement.                                                                                                                                          |
| `tseslint.configs.disableTypeChecked` on JS/config files                                                                                                                                                                                      | typescript-eslint typed-linting docs — Context7                                                                                           | Adopt. Typed rules must not run on files outside a project.                                                                                                                                                                                         |

### 1.3 Size and complexity

Each axis gets the metric that measures it — not file-length alone.

| Metric                         | Measures                                                                       | Threshold                                                                                                                                                                                                          | Source                                                                                                                                                                                                                                     | Severity              |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `max-lines`                    | "too much responsibility in one file"                                          | **300** (rule default; docs note recommendations range 100–500, "should not be in the thousands")                                                                                                                  | https://eslint.org/docs/latest/rules/max-lines                                                                                                                                                                                             | warn→error when clean |
| `max-lines-per-function`       | function doing too much (incl. long chains `complexity`/`max-statements` miss) | **50** (rule default)                                                                                                                                                                                              | https://eslint.org/docs/latest/rules/max-lines-per-function                                                                                                                                                                                | warn→error            |
| `complexity` (cyclomatic)      | testability — minimum number of tests for full path coverage                   | **20** (rule default). NIST SP 500-235 (Watson & McCabe, 1996) canonically recommends v(G) ≤ 10 — recorded as the target; the tool default is adopted first because it is the less disruptive of two good sources. | https://eslint.org/docs/latest/rules/complexity ; https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication500-235.pdf (§2.5)                                                                                                     | warn→error            |
| `sonarjs/cognitive-complexity` | understandability — mental effort to follow control flow                       | **15** (rule default; the SonarSource default)                                                                                                                                                                     | https://github.com/SonarSource/eslint-plugin-sonarjs/blob/master/docs/rules/cognitive-complexity.md ; Campbell, "Cognitive Complexity: A New Way of Measuring Understandability", https://www.sonarsource.com/docs/CognitiveComplexity.pdf | warn→error            |
| `max-depth`                    | nested blocks                                                                  | **4** (rule default)                                                                                                                                                                                               | https://eslint.org/docs/latest/rules/max-depth                                                                                                                                                                                             | warn→error            |
| `max-params`                   | wide interfaces                                                                | **3** (rule default)                                                                                                                                                                                               | https://eslint.org/docs/latest/rules/max-params                                                                                                                                                                                            | warn→error            |
| `max-statements`               | statements per function                                                        | **10** (rule default) + `ignoreTopLevelFunctions: true` so declarative top-level factories are not flagged                                                                                                         | https://eslint.org/docs/latest/rules/max-statements                                                                                                                                                                                        | warn→error            |
| `max-nested-callbacks`         | callback nesting                                                               | **10** (rule default)                                                                                                                                                                                              | https://eslint.org/docs/latest/rules/max-nested-callbacks                                                                                                                                                                                  | warn→error            |

**Why cognitive complexity is the primary metric:** cyclomatic complexity
accurately counts the tests needed but "cries wolf" on maintainability;
cognitive complexity was formulated to match programmers' intuition about
understandability (Campbell 2017). Cyclomatic stays as the testability
signal; cognitive is the readability signal. They complement, not
duplicate.

**Scope differences — justified, not taste:**

- **Test files** get relaxed budgets: the dedicated plugins
  (`@vitest/eslint-plugin`, `eslint-plugin-playwright`) exist precisely
  because test code has its own rule set, and both official READMEs
  prescribe `files:`-scoped configs. `max-statements`/`max-lines-per-function`
  off in tests (long arrange-act-assert bodies are legitimate); nesting is
  governed by the plugins' `max-nested-describe` instead.
- **Generated/declarative files** (drizzle migrations, `*.d.ts`, config
  files) get complexity budgets off — nothing actionable to refactor.
- **UI vs domain/server**: same budgets. No source provides a defensible
  different number per layer; inventing one is out of scope.
- `eslint-plugin-sonarjs` is maintained (v4.x published from
  SonarSource/SonarJS; the standalone repo was archived because
  development moved monorepo). Only `cognitive-complexity` is enabled —
  the rest of the plugin's rules are not individually vetted here.

### 1.4 TypeScript strictness

| Flag                                                                                                                                                                                                          | Source                                                                                                  | Decision                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict: true` (umbrella: noImplicitAny, strictNullChecks, strictFunctionTypes, strictBindCallApply, strictPropertyInitialization, noImplicitThis, alwaysStrict, useUnknownInCatchVariables)                  | TypeScript tsconfig docs                                                                                | Required baseline for new code.                                                                                                                                                           |
| `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`                                                                                                                | TS 4.1 / 4.4 release notes (typescript-website docs via Context7); listed in community `strictest` base | **Deferred** — each forces mechanical edits across the codebase (indexing guards, `prop?: T` vs `prop?: T \| undefined`, dot→bracket). Track as compiler-level ratchets, not this change. |
| `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `allowUnusedLabels: false`, `allowUnreachableCode: false`, `isolatedModules`, `skipLibCheck` | `strictest` base, https://github.com/tsconfig/bases/blob/main/bases/strictest.json                      | Adopt if the codebase compiles clean — cheap flags that catch real issues.                                                                                                                |

### 1.5 React and Next.js

| Practice                                                                             | Source                                                                                                                             | Decision                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| react-hooks recommended: `rules-of-hooks` + `exhaustive-deps` + React Compiler lints | https://react.dev/reference/eslint-plugin-react-hooks                                                                              | Adopt via `eslint-config-next` (bundles plugin v7). Compiler diagnostics surface as lints even without adopting the compiler.                                              |
| Accessibility rules via `jsx-a11y`                                                   | bundled by `eslint-config-next` (its package.json)                                                                                 | Adopt as shipped — vendor-supported a11y coverage, no extra config.                                                                                                        |
| One component per file: `react/no-multi-comp`                                        | https://github.com/jsx-eslint/eslint-plugin-react/blob/master/docs/rules/no-multi-comp.md — "improves readability and reusability" | Adopt `{ "ignoreStateless": true }` scoped to `*.tsx` in app + design-system: multiple small stateless helpers per file is acceptable; a second stateful component is not. |
| UI↔data boundary                                                                     | Next.js docs: `server-only`/`client-only` marker packages                                                                          | Already the vendor mechanism; keep `import 'server-only'` on server-only modules. Layering below is enforced by `no-restricted-imports`.                                   |

### 1.6 Server / domain

| Practice                                                                                    | Source                                                                                                                                              | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Floating/misused promises, un-awaited thenables                                             | `recommendedTypeChecked` (§1.2)                                                                                                                     | Covered — error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `console` vs structured logger                                                              | https://eslint.org/docs/latest/rules/no-console — docs recommend it for browser code and explicitly say Node.js "most likely do not want this rule" | **warn** scoped to app + package source, excluding CLI scripts/tests — rationale for browser is official; for server packages the driver is the project's structured-logger convention (recorded honestly as project policy, not claimed as an industry rule).                                                                                                                                                                                                                                                                                                                       |
| Drizzle foot-guns: `drizzle/enforce-delete-with-where`, `drizzle/enforce-update-with-where` | https://orm.drizzle.team/docs/eslint-plugin — official docs configure both as `"error"`                                                             | **error**. Prevents unscoped table-wide writes. `drizzleObjectName` option exists if false positives appear.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `eslint-plugin-security` full `recommended`                                                 | https://github.com/eslint-community/eslint-plugin-security — own README: "finds a lot of false positives which need triage by a human"              | Rejected as preset. Adopt the low-FP subset as **error**: `detect-bidi-characters`, `detect-invisible-characters` (trojan-source class — real CVE vector), `detect-eval-with-expression`, `detect-child-process`, `detect-buffer-noassert`, `detect-new-buffer`, `detect-pseudoRandomBytes`. Skipped: `detect-object-injection` + `detect-non-literal-*` + `detect-unsafe-regex` + `detect-possible-timing-attacks` (the noisy ones the README warns about), `detect-no-csrf-before-method-override` + `detect-disable-mustache-escape` (Express/Mustache-specific, not this stack). |

### 1.7 Tests and e2e

| Practice                                                                                                                                                                                                    | Source                                                                 | Decision                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@vitest/eslint-plugin` recommended on `**/*.{test,spec}.{ts,tsx}` — `no-focused-tests` error, `no-disabled-tests` warn, `no-commented-out-tests`, `expect-expect`, `valid-expect`, `no-conditional-expect` | https://github.com/vitest-dev/eslint-plugin-vitest README + Context7   | Adopt scoped to test globs with the plugin's shipped severities. Catches focused/skipped tests without relaxing bug rules.              |
| `eslint-plugin-playwright` `flat/recommended` on `**/e2e/**` — `missing-playwright-await`, `no-focused-test`, `no-networkidle`, `no-conditional-expect`, `valid-expect`, `no-force-option`, `no-page-pause` | https://github.com/mskelton/eslint-plugin-playwright README + Context7 | Adopt scoped to `e2e/` — `no-networkidle` catches idle-network waits, `missing-playwright-await` catches unawaited locators/assertions. |
| `max-nested-describe` (both plugins)                                                                                                                                                                        | plugin docs                                                            | Off initially — only adopt if `describe` nesting is actually deep (measure).                                                            |

### 1.8 Import boundaries

| Practice                                                                                   | Source                                                     | Decision                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core `no-restricted-imports` with `patterns` (minimatch `group`/`regex`) — no extra plugin | https://eslint.org/docs/latest/rules/no-restricted-imports | Adopt — the core rule covers package-level restrictions: (a) ban deep imports `@crm/*/src/*` everywhere (imports only via package index exports); (b) `packages/**` may not import `@crm/web`/`apps/*` (dependency direction app → packages); (c) provider `**/adapters/*` modules may not be imported outside their own package's `registry.ts`. |
| `eslint-plugin-boundaries` / `import/no-restricted-paths`                                  | plugin exists (Context7 listing)                           | Reject — core rule suffices; the import-plugin path-based rule is superseded by `patterns`.                                                                                                                                                                                                                                                       |

### 1.9 Pre-commit hook and CI

| Practice                                                                                          | Source                                                             | Decision                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Pre-commit: Prettier on **staged files only** via lefthook `{staged_files}` + `stage_fixed: true` | https://prettier.io/docs/precommit — lefthook is official Option 5 | Adopt.                                                                       |
| `eslint --fix` on staged `*.{ts,tsx,js}` — flat config supports per-file runs                     | lint-staged/lint-on-staged practice; ESLint CLI docs               | Adopt — scoped to staged files, so it cannot become a slow whole-repo gate.  |
| Full `eslint .`, `tsc --noEmit`, tests, `prettier --check`                                        | https://prettier.io/docs/ci + Next 16 (build no longer lints)      | **CI is the error-level barrier.** Nothing heavy moves into the commit hook. |

### 1.10 Severity policy

| Practice                                                                                                                                 | Source                                                                                                                                                                                                        | Decision                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `error` for rules that catch bugs/insecurity or have zero violations; `warn` only as a _temporary_ refactor budget with a recorded count | ESLint maintainer consensus, https://github.com/eslint/eslint/discussions/16512 — "Warnings were designed to aid in transitioning … intended as a temporary measure"; long-term warnings become ignored noise | Adopt. Every warn in the shipped config carries its violation count in §2; a warn is promoted to error when the count reaches zero. |

## 2. Diff and adoption (measured 2026-10-10)

Violation counts below come from a full `eslint .` run per workspace
(`--format json`, all 14 linted workspaces, no `--max-warnings` cap). The
monorepo lints with **0 errors** after adoption.

### 2.1 What the repo already did — classification

**Already conforming** (kept, cited here so future audits don't re-research):

- ESLint 9 flat config centralized in `tooling/eslint` (`@crm/eslint-config`),
  consumed by per-workspace `eslint.config.js` files — matches §1.1.
- `recommendedTypeChecked` + `parserOptions.projectService` +
  `disableTypeChecked` for JS — matches §1.2.
- `apps/web` uses `eslint-config-next/core-web-vitals` (bundled react-hooks,
  jsx-a11y, @next/next) — matches §1.5.
- Prettier is the only formatter; it runs on staged files via lefthook
  (`{staged_files}` + `stage_fixed`) and as `format:check` in CI — matches
  §1.1 and §1.9. No `eslint-plugin-prettier` anywhere.
- `ci.yml` runs `pnpm format:check` + `turbo run lint typecheck test build`
  — CI is the error-level barrier, matching §1.9.
- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `isolatedModules`, `verbatimModuleSyntax` in the shared tsconfig — the
  §1.4 baseline.
- `no-console` already scoped with an observability exemption; drizzle
  where-guards already at error — direction matched §1.6; scope and plugin
  subsets were tightened (below).
- `no-restricted-imports` already banned deep `@crm/*/src` imports —
  extended (below).
- `design-system/eslint.config.js` token rules (`@shadcn/lint`,
  `no-restricted-syntax` on raw hex/px/fonts, DS-internal import
  adherence) — stricter than the external standard **with a documented
  project reason**. No industry source in §1 prescribes "design-token
  lint" — token-adherence tooling is a stack-specific choice, not an
  established cross-stack practice — so these rules are treated as
  enforcement of the DESIGN.md contract (documented in
  `docs/development/design-system-lint.md`), not as unsourced strictness.
  Measured: both warn-level shadcn rules carry counts in §2.3; the
  error-level rules (`no-arbitrary-values`, `no-raw-colors`,
  `no-unknown-classes`, syntax/import adherence) measured **zero
  violations**.

**Divergent or absent — changed:**

- Prettier/lint boundary: `eslint-config-prettier` was missing — added as
  the last config entry so no lint rule can fight the formatter (§1.1).
- `sonarjs/cognitive-complexity` missing — added (`eslint-plugin-sonarjs`,
  the only rule enabled; §1.3).
- Core size/complexity family absent — added with documented defaults
  (§1.3): `complexity`, `max-depth`, `max-params`, `max-statements`,
  `max-nested-callbacks`, `max-lines-per-function`, `max-lines`, all scoped
  to `**/src/**`.
- `stylisticTypeChecked` absent — adopted measured rule by rule (§2.2).
- `eslint-plugin-security`: only 3 rules were on — expanded to the low-FP
  subset (§1.6), still rejecting the plugin's noisy half.
- `no-restricted-imports` boundaries incomplete — consolidated into one
  pattern list per scope (flat config replaces, never merges, same-rule
  options): `@crm/*/src|dist|adapters` deep-import ban + `@crm/web`/`apps/`
  dependency direction on all files; plus the adapters-outside-registry
  regex on `src/**` with `src/registry.ts` exempt.
- `react/no-multi-comp` absent — added `{ ignoreStateless: true }` on
  `*.tsx` (§1.5).
- Playwright config listed a small hand-picked rule set — replaced with the
  vendor's `flat/recommended` spread so e2e coverage tracks the plugin.
- `lefthook.yml` has **no** eslint job, and stays that way — §1.9's
  `eslint --fix` idea is **not adopted**: flat config resolves from cwd, so
  linting staged files from the repo root would apply the wrong (or no)
  per-package config; whole-repo `pnpm lint` is turbo-cached and CI-gated.
  This is the documented exception to the §1 row.
- TypeScript flags (§1.4 "adopt if clean" row): `noFallthroughCasesInSwitch`,
  `noUnusedLocals`, `noUnusedParameters`, `allowUnusedLabels: false`,
  `allowUnreachableCode: false` — all compiled clean → **adopted**.
  `noImplicitReturns` compiled with **1 violation** (a test-stub callback
  mixing `return res.end()` and bare fall-through) → **deferred**, not
  adopted; the flag and its count are recorded here as a known ratchet.
- `noUncheckedSideEffectImports`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature` — deferred per §1.4 (mechanical
  migration cost).

### 2.2 `stylisticTypeChecked` — measured rule by rule

Preset adopted; two rules turned **off** (pure preference with a settled
codebase convention, not a defect class):

| Rule                                             | Violations | Decision                                                                                                   |
| ------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `@typescript-eslint/consistent-type-definitions` | 89         | off — the repo standardized on `type` aliases; forcing `interface` is a mass rename with zero quality gain |
| `@typescript-eslint/array-type`                  | 16         | off — `T[]` vs `Array<T>` is style                                                                         |

All other rules in the preset measured **zero violations** → kept at the
preset's error severity (e.g. `consistent-type-assertions`,
`prefer-for-of`, `prefer-optional-chain`).

### 2.3 Warning budgets — counts blocking promotion

Promotion rule: when a count reaches zero, the severity goes to `error` in
the same commit that removes it from this table. The 2026-10 lint-warnings
cleanup (`chore/lint-warnings`) zeroed and promoted every size/complexity
rule and the defect-adjacent stylistic ones; what is left:

| Rule                           | Threshold            | Violations |
| ------------------------------ | -------------------- | ---------- |
| `playwright/no-useless-not`    | preset warn          | 1          |
| `shadcn/no-inline-styles`      | design-system config | 2          |
| `security/detect-unsafe-regex` | heuristic            | —          |
| `react/no-multi-comp`          | ignoreStateless      | —          |

The two `no-inline-styles` are in `deal-card.tsx`: dnd-kit's `transform` and
`transition` are runtime values that token classes cannot express without
changing the drag animation. `security/detect-unsafe-regex` is a heuristic
and stays a warn by design.

Promoted to **error** on zero measured violations: `max-lines-per-function` (50), `max-statements` (10), `max-params` (3), `max-lines` (300), `sonarjs/cognitive-complexity` (15), `no-empty-function`, `dot-notation`, `non-nullable-type-assertion-style`, `prefer-includes`, `prefer-nullish-coalescing`, `no-unnecessary-condition`, `vitest/no-conditional-expect`, `shadcn/require-static-classes`, plus the earlier set: `complexity` (20),
`max-depth` (4), `max-nested-callbacks` (10), all of
`stylisticTypeChecked` except the two off-rules and the warns above, the
security subset (§1.6), both drizzle where-guards,
`vitest/valid-expect` (with `maxArgs: 2` — Vitest's documented
`expect(actual, message)` arity), `vitest/no-focused-tests`, and every
error-level rule in `playwright flat/recommended`.

### 2.4 Rejected — with reason

- `eslint-plugin-prettier` — officially discouraged (§1.1).
- A second linter (Biome/Oxlint) — no measured gain; plugin coverage
  missing (§1.1).
- `strictTypeChecked` wholesale — docs themselves caution it's for
  highly-proficient teams and not semver-stable; individual rules were
  adopted by measurement instead (§1.2).
- `eslint-plugin-security` `recommended` preset — the README itself warns
  it "finds a lot of false positives"; the low-FP subset is what ships
  (§1.6). `detect-object-injection` additionally duplicates
  `noUncheckedIndexedAccess` coverage.
- `eslint-plugin-boundaries` / `import/no-restricted-paths` — core
  `no-restricted-imports` `patterns` covers the need (§1.8).
- `max-nested-describe` — measured: `describe` nesting is not deep enough
  to need a dedicated rule (§1.7).
- `eslint --fix` in the pre-commit hook — flat-config cwd resolution makes
  per-file lint from the root incorrect; CI stays the barrier (§2.1).
- `noImplicitReturns` — 1 measured violation; deferred ratchet (§2.1).

### 2.5 Files changed

- `tooling/eslint/base.js` — rewritten per §1 (presets, plugin subsets,
  budgets, consolidated boundaries, test relaxations).
- `tooling/eslint/playwright.js` — vendor `flat/recommended` spread.
- `tooling/eslint/package.json` — added `eslint-plugin-sonarjs`,
  `eslint-config-prettier`, `eslint-plugin-react`, `@vitest/eslint-plugin`,
  `eslint-plugin-drizzle`, `eslint-plugin-security`,
  `eslint-plugin-playwright`, `eslint-plugin-simple-import-sort`,
  `globals` as needed.
- `tooling/typescript/base.json` — 5 strictness flags adopted (§2.1).
- This document.

import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import vitest from "@vitest/eslint-plugin";
import drizzle from "eslint-plugin-drizzle";
import react from "eslint-plugin-react";
import security from "eslint-plugin-security";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";

// Test files and test-support files, matched either by suffix or by living in
// a fixture/mock directory. Reused by the relaxations block and the vitest
// plugin block at the bottom of this config.
const TEST_FILE_GLOBS = [
  "**/*.test.{ts,tsx}",
  "**/*.int.test.{ts,tsx}",
  "**/{__fixtures__,__mocks__,fixtures,mocks}/**/*.{ts,tsx}",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/migrations/**",
      // NOTE: e2e/ is deliberately NOT ignored — a flat-config global ignore
      // can never be re-enabled, so it would make the playwright block in
      // apps/web dead config. Spec files (*.spec.ts) don't match the vitest
      // test globs, and src/-scoped rules don't reach e2e/ either.
      "**/*.tsbuildinfo",
      "**/playwright-report/**",
      "**/test-results/**",
      // Per-package vitest stubs are 2-line re-exports of
      // vitest.unit.shared.ts — outside every tsconfig (packages only
      // include src/), so the typed projectService can't parse them.
      "**/vitest.config.ts",
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
      // stylisticTypeChecked preset — measured rule by rule 2026-10 across all
      // 14 workspaces. Pure-preference rules with a real codebase convention
      // already settled are off (not warn — nothing to fix):
      //   consistent-type-definitions: 89 — repo standardized on `type`
      //   array-type: 16 — `T[]` vs `Array<T>` is style, not quality
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/array-type": "off",
      // Defect-adjacent stylistic rules — zero violations measured 2026-10 → error.
      "@typescript-eslint/no-empty-function": "error",
      "@typescript-eslint/dot-notation": "error",
      "@typescript-eslint/non-nullable-type-assertion-style": "error",
      "@typescript-eslint/prefer-includes": "error",
      // Always-a-bug tier (all files, JS and TS alike).
      "no-var": "error",
      "prefer-const": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
      // allowSeparateTypeImports: the codebase splits `import type` from value
      // imports on purpose (enforced by consistent-type-imports). The rule
      // still catches same-kind duplicates.
      "no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
      // `== null` stays allowed — it is the idiomatic null-or-undefined check.
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    // Production code never writes to the console directly — it goes through
    // the @crm/observability logger. Exemptions live in the blocks AFTER this
    // one (flat config applies later blocks last for files matched by both).
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // CLI-style entry points and the logger implementation itself.
    files: [
      // Repo-root glob: matches when eslint runs from the workspace root. The
      // observability package also disables no-console in its own config,
      // because per-package runs never see a "packages/observability" prefix.
      "packages/observability/**",
      "**/seed.ts",
      "**/init-bucket.ts",
      "**/scripts/**",
      "tooling/**",
    ],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Security lint over application source only (not config/scripts/tests —
    // tests intentionally hit some of these patterns). Low-false-positive
    // subset: the plugin's own README warns the full recommended preset
    // "finds a lot of false positives which need triage by a human".
    files: ["**/src/**/*.{ts,tsx}"],
    plugins: { security },
    rules: {
      // Trojan-source class (unicode bidi / invisible glyphs) — real CVE
      // vector, near-zero false positives.
      "security/detect-bidi-characters": "error",
      "security/detect-invisible-characters": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-child-process": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-new-buffer": "error",
      "security/detect-pseudoRandomBytes": "error",
      // Heuristic ReDoS detector — kept as warn; flagged patterns need human
      // triage (README's own caveat).
      "security/detect-unsafe-regex": "warn",
      // Deliberately NOT enabled: security/detect-object-injection fires on
      // every obj[variable] access — noUncheckedIndexedAccess already forces
      // handling of the resulting undefined, so the rule is pure noise here.
      // detect-non-literal-* / detect-possible-timing-attacks are the
      // high-false-positive half of the preset; detect-no-csrf-* and
      // detect-disable-mustache-escape target Express/Mustache stacks we
      // don't use.
    },
  },
  {
    // Drizzle foot-guns: delete()/update() without .where() wipes the table.
    // drizzleObjectName limits the check to our known handles (db, tx) so
    // unrelated objects with a delete/update method don't trip it.
    files: ["**/src/**/*.{ts,tsx}"],
    plugins: { drizzle },
    rules: {
      "drizzle/enforce-delete-with-where": ["error", { drizzleObjectName: ["db", "tx"] }],
      "drizzle/enforce-update-with-where": ["error", { drizzleObjectName: ["db", "tx"] }],
    },
  },
  {
    // Size/complexity gate. Each
    // threshold is the rule's documented default; the canonical NIST target
    // for cyclomatic complexity is 10 (NIST SP 500-235 §2.5). All rules are "error" since the 2026-10
    // lint-warnings cleanup — see docs/development/code-quality-standard.md §2.3.
    files: ["**/src/**/*.{ts,tsx}"],
    plugins: { sonarjs },
    rules: {
      // Understandability (hard to follow) — SonarSource default.
      "sonarjs/cognitive-complexity": ["error", 15],
      // Testability (min tests for full path coverage) — ESLint default.
      // Zero violations measured 2026-10 → error.
      complexity: ["error", 20],
      "max-depth": ["error", 4],
      "max-params": ["error", 3],
      // Too much in one place.
      "max-statements": ["error", { max: 10 }],
      // Zero violations measured 2026-10 → error.
      "max-nested-callbacks": ["error", 10],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  // Import boundaries. NOTE: in flat config, when two config objects set the
  // same rule on the same file the LAST object's options replace the
  // earlier ones — patterns are not merged. Each scope below therefore
  // repeats the full pattern list it needs.
  {
    // Package internals are private: cross-package imports resolve through
    // each package's index exports (package.json "exports"), never into
    // src/, dist/, or adapters/. Dependency direction is app → packages:
    // nothing may reach back into the web app. Applies to the import
    // specifier, so it works from any workspace CWD.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@crm/*/src/**", "@crm/*/dist/**", "@crm/*/adapters/**"],
              message:
                "Deep imports into package internals are not allowed. Import via the package's index exports.",
            },
            {
              group: ["@crm/web", "@crm/web/**", "apps/**"],
              message: "Dependency direction is app → packages. Packages must not import the app.",
            },
            {
              regex: "^(\\.\\./)+apps/",
              message: "Dependency direction is app → packages. Packages must not import the app.",
            },
          ],
        },
      ],
    },
  },
  {
    // src/ files additionally may not import provider adapters — those are
    // constructed only inside their package's registry factory
    // (create*Provider in src/registry.ts). Repeats the general patterns so
    // this scope's rule options don't silently replace them.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/registry.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@crm/*/src/**", "@crm/*/dist/**", "@crm/*/adapters/**"],
              message:
                "Deep imports into package internals are not allowed. Import via the package's index exports.",
            },
            {
              group: ["@crm/web", "@crm/web/**", "apps/**"],
              message: "Dependency direction is app → packages. Packages must not import the app.",
            },
            {
              regex: "^(\\.\\./)+apps/",
              message: "Dependency direction is app → packages. Packages must not import the app.",
            },
            {
              regex: "(^|/)adapters(/|$)",
              message:
                "Provider adapters are constructed only inside src/registry.ts (create*Provider). Import the registry or the provider interface instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      // Config files and scripts are Node code — declare the runtime so
      // no-undef doesn't fire on process/console/etc.
      globals: globals.node,
    },
  },
  {
    // Promotions from strictTypeChecked, adopted 2026-10 after a repo-wide
    // violation count: the three "error" rules had zero violations;
    // nullish-coalescing and unnecessary-condition were promoted once their counts reached zero. See docs/adr/0013.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
    },
  },
  {
    // One component per file — small stateless helpers may colocate
    // (ignoreStateless); a second stateful component may not.
    files: ["**/*.tsx"],
    plugins: { react },
    settings: { react: { version: "detect" } },
    rules: {
      "react/no-multi-comp": ["warn", { ignoreStateless: true }],
    },
  },
  {
    // Test files get relaxed size limits (describe/it nesting and long
    // arrange sections are normal) and mock-friendly typings. This block and
    // the vitest block MUST stay last — they override earlier blocks for
    // files they match. max-params stays on for tests on purpose.
    files: TEST_FILE_GLOBS,
    plugins: { vitest },
    rules: {
      "max-statements": "off",
      "max-lines-per-function": "off",
      "max-nested-callbacks": "off",
      "no-console": "off",
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
      ...vitest.configs.recommended.rules,
      // Vitest's expect takes an optional message as arg 2
      // (vitest.dev/api/expect) — the rule's default maxArgs:1 predates that.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/no-conditional-expect": "error",
    },
  },
  // Prettier owns formatting; this disables any lint rule that could fight
  // it (docs: prettier.io/docs/integrating-with-linters). Must stay last.
  eslintConfigPrettier,
);

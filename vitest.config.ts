import { defineConfig, mergeConfig } from "vitest/config";

import shared from "./vitest.unit.shared.js";

// Unit tests only: `*.test.ts` must not require external infrastructure.
// Integration tests live in `*.int.test.ts` and run via `pnpm test:integration`.
// Perf flags live in vitest.unit.shared.ts — per-package stubs re-export
// it so `turbo run test` (CI) matches this run.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: [
        "packages/**/*.test.ts",
        "apps/**/*.test.{ts,tsx}",
        "design-system/**/*.test.ts",
        ".claude/hooks/**/*.test.mjs",
      ],
      exclude: ["**/*.int.test.ts", "**/node_modules/**", "**/.next/**"],
    },
  }),
);

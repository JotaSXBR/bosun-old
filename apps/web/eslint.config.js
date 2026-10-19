import { designSystemAdherence } from "@crm/eslint-config/design-system";
import next from "@crm/eslint-config/next";
import playwright from "@crm/eslint-config/playwright";
import { plugin as shadcn } from "@shadcn/lint";

const UI_BOUNDARY_MESSAGE =
  "UI must not touch the database or server auth; go through src/server helpers and @crm/core services.";

const config = [
  ...next,
  ...playwright,
  {
    ignores: ["test-results/**", "playwright-report/**", ".next/**"],
  },
  {
    // UI layer boundary: .tsx files and component code never import the db
    // handle, drizzle, or the server-side auth composition directly. Server
    // code (route handlers, server actions, src/server/*) keeps direct access.
    files: ["src/**/*.tsx", "src/components/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@crm/db", message: UI_BOUNDARY_MESSAGE },
            { name: "drizzle-orm", message: UI_BOUNDARY_MESSAGE },
            { name: "@crm/auth", message: UI_BOUNDARY_MESSAGE },
          ],
          patterns: [{ group: ["@crm/db/*", "drizzle-orm/*"], message: UI_BOUNDARY_MESSAGE }],
        },
      ],
    },
  },
  {
    // Design-system linter — token rules are errors; dynamic-value escapes
    // (dnd transforms, sonner hooks) stay warnings. See
    // docs/development/design-system-lint.md.
    files: ["src/**/*.tsx"],
    plugins: { shadcn },
    rules: {
      "shadcn/no-arbitrary-values": "error",
      "shadcn/no-raw-colors": "error",
      "shadcn/no-inline-styles": "error",
      "shadcn/require-static-classes": "error",
      "shadcn/no-unknown-classes": "error",
    },
  },
  designSystemAdherence({ files: ["src/**/*.tsx"] }),
];

export default config;

import base from "@crm/eslint-config/base";
import { designSystemAdherence } from "@crm/eslint-config/design-system";
import { plugin as shadcn } from "@shadcn/lint";

const config = [
  ...base,
  {
    ignores: ["reference/**"],
  },
  {
    // Design-system linter — primitives legitimately use arbitrary values
    // (centering, radix CSS vars, focus rings) and Sonner's `toaster` hook;
    // those are allowlisted, everything else must use theme tokens. See
    // docs/development/design-system-lint.md.
    files: ["src/**/*.tsx"],
    plugins: { shadcn },
    rules: {
      "shadcn/no-arbitrary-values": [
        "error",
        {
          allow: [
            // Only values actually used under src/ — each needs a comment.
            "ring-[3px]", // RingChart value-chip halo over the track
            "grid-cols-[*]", // showcase icon grid auto-fill
            "transition-[color,box-shadow]", // Textarea focus ring
            "scale-[0.985]", // Button press motion constant
            "transition-[width]", // ProgressBar fill animates width
            "transition-[left]", // ProgressBar thumb animates left
            "transition-[stroke-dasharray]", // RingChart svg stroke animation
          ],
        },
      ],
      "shadcn/no-raw-colors": "error",
      "shadcn/no-inline-styles": "warn",
      "shadcn/require-static-classes": "error",
      "shadcn/no-unknown-classes": [
        "error",
        {
          allow: [
            "toaster",
            // BOSUN pattern & card classes defined in globals.css / patterns.css
            "bx-*",
            "card-fillet",
          ],
        },
      ],
    },
  },
  designSystemAdherence({ files: ["src/**/*.tsx"], restrictImports: false }),
];

export default config;

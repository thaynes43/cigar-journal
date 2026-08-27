import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Shared ESLint 9 flat config for the workspace. Consumers spread this and may
// prepend their own `ignores`. Formatting is Prettier's job — `prettier` last
// switches off every rule that would fight it.
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      // TypeScript resolves identifiers itself; the core rule only double-reports.
      "no-undef": "off",
    },
  },
  prettier,
);

import config from "@cj/config/eslint";

// Repo-specific ignores layered over the shared flat config. archive/ is a
// deployed artifact on its own toolchain — not ours to lint.
export default [
  { ignores: ["archive/**", "docs/**", ".agents/**"] },
  ...config,
  {
    // ADR-011 containment, enforced. The mint is deliberately absent from
    // @cj/oauth's public entrypoint and the package's `exports` map blocks
    // subpath imports, but a relative path into packages/oauth/src/ walks around
    // both. Nothing outside @cj/oauth may reach the module that writes
    // long-lived credentials — the whole invariant is that no network-facing
    // code can mint one.
    files: ["apps/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
    ignores: ["packages/oauth/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/oauth/src/service-tokens*", "**/oauth/src/cli*"],
              message:
                "The service-token mint is not importable outside @cj/oauth (ADR-011): only the `token` role CLI may reach it.",
            },
          ],
        },
      ],
    },
  },
];

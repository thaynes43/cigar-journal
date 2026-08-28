import config from "@cj/config/eslint";

// Repo-specific ignores layered over the shared flat config. archive/ is a
// deployed artifact on its own toolchain — not ours to lint.
export default [{ ignores: ["archive/**", "docs/**", ".agents/**"] }, ...config];

import config from "@cj/config/eslint";

// Repo-specific ignores layered over the shared flat config. spike/ and
// archive/ are deployed artifacts on their own toolchains — not ours to lint.
export default [{ ignores: ["spike/**", "archive/**", "docs/**", ".agents/**"] }, ...config];

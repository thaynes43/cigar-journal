// Stands in for the `server-only` package under Vitest. Next supplies that
// module at build time; it does not exist in node_modules, so importing any
// server module that guards itself with it would fail to resolve. Aliased in
// vitest.config.ts.
export {};

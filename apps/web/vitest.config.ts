import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web project's own Vitest config so route-handler tests resolve the `@/*`
// path alias exactly as Next (tsconfig paths) does in the app and build.
const webRoot = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  // Next's tsconfig keeps `jsx: preserve`, so tell esbuild how to compile the
  // component render tests.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": webRoot,
    },
  },
});

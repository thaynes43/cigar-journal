import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web project's own Vitest config so route-handler tests resolve the `@/*`
// path alias exactly as Next (tsconfig paths) does in the app and build.
const webRoot = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

export default defineConfig({
  resolve: {
    alias: {
      "@": webRoot,
    },
  },
});

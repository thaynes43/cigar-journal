import { defineConfig } from "vitest/config";

// One workspace test run across every package and app. Each project keeps its
// own tests colocated with source; add a new project when a new package lands.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});

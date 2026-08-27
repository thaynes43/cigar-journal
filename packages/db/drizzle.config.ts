import { defineConfig } from "drizzle-kit";

// drizzle-kit is used for generating/inspecting numbered SQL only. Migrations
// themselves are applied by the advisory-locked `migrate` init container at
// startup, never by drizzle-kit push (ADR-003).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});

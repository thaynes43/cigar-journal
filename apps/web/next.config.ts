import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  // Standalone server for the container image (ADR-001). The tracing root is
  // the monorepo root so traced files resolve once workspace packages are used.
  output: "standalone",
  outputFileTracingRoot: rootDir,
  // Linting is a dedicated CI job (`pnpm lint`), not the build's concern.
  eslint: { ignoreDuringBuilds: true },
};

export default config;

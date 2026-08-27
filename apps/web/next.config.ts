import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  // Standalone server for the container image (ADR-001). The tracing root is
  // the monorepo root so traced files resolve once workspace packages are used.
  output: "standalone",
  outputFileTracingRoot: rootDir,
  // Workspace packages ship raw TS (no build step) — Next must transpile them.
  transpilePackages: ["@cj/auth", "@cj/db", "@cj/domain", "@cj/oauth"],
  // Those packages are NodeNext ESM: their relative imports carry `.js`
  // extensions that resolve to `.ts` sources. Teach webpack the same mapping.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias as Record<string, string[]> | undefined),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
  // Linting is a dedicated CI job (`pnpm lint`), not the build's concern.
  eslint: { ignoreDuringBuilds: true },
};

export default config;

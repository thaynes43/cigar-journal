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
  transpilePackages: ["@cj/auth", "@cj/db", "@cj/domain", "@cj/oauth", "@cj/photos"],
  // The photo pipeline's native/WASM/SDK deps must not be bundled — keep them as
  // runtime requires (sharp is native; heic-convert loads a libheif WASM bundle
  // via dynamic require; the AWS SDK is large and self-contained).
  serverExternalPackages: ["sharp", "heic-convert", "@aws-sdk/client-s3"],
  // Those packages are NodeNext ESM: their relative imports carry `.js`
  // extensions that resolve to `.ts` sources. Teach webpack the same mapping.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias as Record<string, string[]> | undefined),
      ".js": [".ts", ".tsx", ".js"],
    };
    // libheif-js (heic-convert's WASM decoder) loads its bundle via a dynamic
    // require webpack can't statically trace — a benign "Critical dependency"
    // warning that resolves fine at runtime. Scope-silence just that module.
    config.ignoreWarnings = [
      ...((config.ignoreWarnings as unknown[] | undefined) ?? []),
      { module: /libheif-js/ },
    ];
    return config;
  },
  // Linting is a dedicated CI job (`pnpm lint`), not the build's concern.
  eslint: { ignoreDuringBuilds: true },
};

export default config;

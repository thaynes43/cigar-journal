// Cigar Journal MCP server — HTTP entrypoint (@cj/mcp, ADR-001 separate role).
// A standalone long-running Node service over @cj/db + @cj/oauth + @cj/domain.
// Role command in k8s: workingDir /app/mcp, `node --import tsx src/index.ts`.

import type { Server } from "node:http";
import { createDatabase } from "@cj/db";
import type { Deps } from "@cj/domain";
import { buildApp } from "./app.js";
import { port, protectedResourceMetadataUrl, webOrigin } from "./config.js";
import { mcpEvent } from "./logger.js";

function main(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  // Fails fast if BETTER_AUTH_URL is unset: the resource identifier and the
  // discovery URLs all derive from it (RFC 8707 audience binding).
  const prm = protectedResourceMetadataUrl();

  const { db } = createDatabase(databaseUrl);
  const deps: Deps = { db, now: () => new Date() };
  const app = buildApp(deps);

  const listenPort = port();
  const httpServer: Server = app.listen(listenPort, () => {
    mcpEvent("startup", { port: listenPort, webOrigin: webOrigin(), protectedResourceMetadata: prm });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      mcpEvent("shutdown", { signal });
      httpServer.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

main();

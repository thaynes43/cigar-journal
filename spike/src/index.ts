// Phase 0 MCP connectivity spike — HTTP entrypoint.
// Mounts: GET /healthz, the Streamable HTTP MCP transport at /mcp, and (when
// SPIKE_AUTH=oauth) a full OAuth 2.1 AS/RS on the same origin.

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { TestValueStore } from "./store.js";
import { createMcpServer } from "./mcp.js";
import { SpikeOAuthProvider } from "./auth/provider.js";
import { registerLoginRoutes } from "./auth/loginPage.js";

const config = loadConfig();
const store = new TestValueStore(config.stateFile);

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", auth: config.authMode, resource: config.resourceUrl });
});

const SCOPES = ["catalog:read", "journal:read", "journal:write", "offline_access"];

// One Streamable HTTP transport per MCP session, keyed by the mcp-session-id
// header the SDK assigns on initialize (stateful mode). A fresh initialize with
// no session id creates one — that is the "stateless-ish" entry the SDK
// prescribes.
const transports = new Map<string, StreamableHTTPServerTransport>();

async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (sessionId || !isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session; send an initialize request first" },
        id: null,
      });
      return;
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: config.jsonResponse,
      onsessioninitialized: (sid: string) => {
        transports.set(sid, transport as StreamableHTTPServerTransport);
        log("mcp", "session initialized", { sessionId: sid });
      },
    });
    transport.onclose = () => {
      if (transport && transport.sessionId) {
        transports.delete(transport.sessionId);
        log("mcp", "session closed", { sessionId: transport.sessionId });
      }
    };
    const server = createMcpServer(store);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
}

async function handleMcpSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing mcp-session-id");
    return;
  }
  await transport.handleRequest(req, res);
}

if (config.authMode === "oauth") {
  if (!config.passcode) {
    log("startup", "WARNING: SPIKE_AUTH=oauth but SPIKE_PASSCODE is empty — no one can log in");
  }
  const provider = new SpikeOAuthProvider(config);

  // OAuth AS + RS metadata, /authorize, /token, /register (DCR), /revoke.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicOrigin),
      baseUrl: new URL(config.publicOrigin),
      resourceServerUrl: new URL(config.resourceUrl),
      scopesSupported: SCOPES,
      resourceName: "Cigar Journal Spike MCP",
    }),
  );

  // Also serve protected-resource metadata at the bare well-known path (some
  // clients probe the root before the path-specific one).
  const prmUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.resourceUrl));
  app.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: config.resourceUrl,
      authorization_servers: [new URL(config.publicOrigin).href],
      scopes_supported: SCOPES,
      resource_name: "Cigar Journal Spike MCP",
    });
  });

  registerLoginRoutes(app, provider, config);

  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: prmUrl });
  app.post("/mcp", bearer, express.json(), (req, res) => void handleMcpPost(req, res));
  app.get("/mcp", bearer, (req, res) => void handleMcpSessionRequest(req, res));
  app.delete("/mcp", bearer, (req, res) => void handleMcpSessionRequest(req, res));

  log("startup", "auth mode: oauth", { issuer: config.publicOrigin, resource: config.resourceUrl, prm: prmUrl });
} else {
  app.post("/mcp", express.json(), (req, res) => void handleMcpPost(req, res));
  app.get("/mcp", (req, res) => void handleMcpSessionRequest(req, res));
  app.delete("/mcp", (req, res) => void handleMcpSessionRequest(req, res));

  log("startup", "auth mode: none (authless connectivity mode)");
}

const httpServer = app.listen(config.port, () => {
  log("startup", `listening on :${config.port}`, {
    mcp: `${config.publicOrigin}/mcp`,
    healthz: `${config.publicOrigin}/healthz`,
    jsonResponse: config.jsonResponse,
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("shutdown", `received ${sig}, closing`);
    httpServer.close(() => process.exit(0));
    // Hard exit if connections linger.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "@cj/domain";
import { createMcpServer } from "./server.js";
import { bearerAuth } from "./auth.js";
import { jsonResponseEnabled } from "./config.js";
import { mcpEvent } from "./logger.js";

// The HTTP surface: GET /healthz and the Streamable HTTP MCP transport at /mcp
// (ADR-005). One transport per MCP session, keyed by the mcp-session-id the SDK
// assigns on initialize — the spike-proven shape. A fresh initialize with no
// session id creates a session and its own McpServer over @cj/domain.

export function buildApp(deps: Deps): express.Express {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

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
        enableJsonResponse: jsonResponseEnabled(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport as StreamableHTTPServerTransport);
          mcpEvent("session_initialized", { sessionId: sid });
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) {
          transports.delete(transport.sessionId);
          mcpEvent("session_closed", { sessionId: transport.sessionId });
        }
      };
      const server = createMcpServer(deps);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  }

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing mcp-session-id");
      return;
    }
    await transport.handleRequest(req, res);
  }

  // express.json() runs before bearerAuth so the parsed JSON-RPC body is
  // available for per-tool scope determination (see requiredScopesForBody).
  app.post("/mcp", express.json(), bearerAuth(deps.db), (req, res) => void handlePost(req, res));
  app.get("/mcp", bearerAuth(deps.db), (req, res) => void handleSessionRequest(req, res));
  app.delete("/mcp", bearerAuth(deps.db), (req, res) => void handleSessionRequest(req, res));

  return app;
}

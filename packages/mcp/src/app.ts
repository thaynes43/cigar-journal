import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "@cj/domain";
import { photoStorageFromEnv, type PhotoStorage } from "@cj/photos";
import { createMcpServer } from "./server.js";
import { bearerAuth } from "./auth.js";
import { jsonResponseEnabled } from "./config.js";
import { mcpEvent } from "./logger.js";
import { describeRequestMeta, shapeOf } from "./photo-intake.js";

// The JSON-RPC body limit for /mcp. See the note on the express.json() call below:
// this is an UNAUTHENTICATED memory budget, because the body is buffered before
// bearerAuth runs.
const MAX_BODY_BYTES = "100kb";

// The HTTP surface: GET /healthz and the Streamable HTTP MCP transport at /mcp
// (ADR-005). One transport per MCP session, keyed by the mcp-session-id the SDK
// assigns on initialize — the spike-proven shape. A fresh initialize with no
// session id creates a session and its own McpServer over @cj/domain.

// The photo intake probe (see photo-intake.ts). It runs at the HTTP layer, on the
// RAW JSON-RPC body, because the MCP SDK validates tool input
// BEFORE the handler runs and raises a rejection as McpError(InvalidParams) —
// which never reaches `mcpEvent`. So a call carrying an undeclared top-level key
// (the `.strict()` schema refuses it, and deliberately keeps refusing it: relaxing
// would flip `additionalProperties` in the published manifest) leaves ZERO trace
// today. This record is the one that can finally answer the owner's real question:
// does the host put the file somewhere we never looked?
//
// It is TOTAL by construction — it reads, never mutates; tolerates a JSON-RPC
// batch array; returns immediately for any other method; and every call site
// wraps it in try/catch. A diagnostic must never become an outage.
//
// It sits AFTER bearerAuth on purpose: before it, an unauthenticated caller could
// write arbitrary key names into Loki.
// A correlation handle, bounded. Strings are truncated, numbers pass through, and
// anything else becomes its type name rather than its content — the value is only
// ever used to join two log lines, so shape is irrelevant and unbounded input is a
// liability.
const MAX_LOG_SCALAR = 64;
function scalarForLog(value: unknown): string | number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : "<number>";
  if (typeof value === "string") {
    return value.length > MAX_LOG_SCALAR ? `${value.slice(0, MAX_LOG_SCALAR)}…` : value;
  }
  return `<${Array.isArray(value) ? "array" : typeof value}>`;
}

function logPhotoIntakeRequest(body: unknown, sessionId: string | undefined): void {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const rpc = message as Record<string, unknown>;
    if (rpc.method !== "tools/call") continue;
    const params = rpc.params;
    if (typeof params !== "object" || params === null) continue;
    const call = params as Record<string, unknown>;
    // Both photo tools declare a file input, so both must be probed: a host that
    // forwards an attachment to open_photo_drop and gets it refused would
    // otherwise leave no trace at all (ADR-014).
    if (call.name !== "add_smoke_photo" && call.name !== "open_photo_drop") continue;

    const args = call.arguments;
    const image =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>).image
        : undefined;

    // Key names and JSON types only — never a handle's values (a download_url is a
    // short-lived credential; its path and query are the credential).
    mcpEvent("photo_intake_request", {
      tool: call.name,
      // Both of these come from the caller and neither has been validated yet:
      // `mcp-session-id` is a raw header, and `id` is any JSON value off an
      // unparsed JSON-RPC body — an object, an array, or a megabyte of string.
      // They are correlation handles, so a bounded scalar is all that is useful;
      // logging them raw would let an unvalidated request write arbitrary
      // structure into Loki.
      sessionId: scalarForLog(sessionId),
      rpcId: scalarForLog(rpc.id),
      // `paramKeys` is the whole point of the probe and was missing: without it the
      // record only described the two places we ALREADY look (`arguments` and
      // `params._meta`), so it could never answer "does the host put the file
      // somewhere we never looked?" — a file handed over as `params.attachments`
      // or `params.files` would have left exactly the same line as no file at all.
      paramKeys: shapeOf(params).keys,
      argKeys: shapeOf(args).keys,
      argImage: shapeOf(image),
      metaKeys: shapeOf(call._meta).keys,
      metaFileParams: describeRequestMeta(call._meta),
    });
  }
}

// `storage` is the photo object store (ADR-007), read once from the environment
// and shared across sessions; null when photos are unconfigured, in which case the
// photo tools return the contract `unavailable`. Injectable so tests can pass an
// in-memory store.
export function buildApp(
  deps: Deps,
  storage: PhotoStorage | null = photoStorageFromEnv(),
): express.Express {
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
      const server = createMcpServer(deps, storage);
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
  // The photo probe follows bearerAuth and precedes the transport, so a photo-tool
  // call is recorded even when the SDK rejects its arguments.
  //
  // THE LIMIT IS EXPLICIT AND SMALL, ON PURPOSE. Every message this endpoint takes
  // is JSON-RPC text — a tool call with a narrative and a file HANDLE, never file
  // bytes — so 100KB is roomy. It stays small because express.json() buffers the
  // whole body BEFORE bearerAuth runs, which makes the limit an unauthenticated
  // memory budget: raising it to fit an inline-base64 photo (~27MB for a 20MB
  // image) would have handed every caller a 27MB pre-auth allocation. That is the
  // trade that removed inline delivery from this change (photo-intake.ts).
  app.post(
    "/mcp",
    // `type: () => true` so EVERY content type is parsed as JSON rather than
    // skipped. /mcp speaks only JSON-RPC, so a non-JSON body is always a bad
    // request — but express.json()'s default type matcher SKIPS a body whose
    // Content-Type is not application/json, leaving req.body empty and throwing
    // nothing. The probe then saw no tools/call, the error handler never ran, and
    // the request failed with zero server-side records: the same silent-failure
    // class this change exists to end, one content-type header away. Parsing it
    // turns that into an entity.parse.failed the error handler records.
    express.json({ limit: MAX_BODY_BYTES, type: () => true }),
    bearerAuth(deps.db),
    (req, _res, next) => {
      try {
        logPhotoIntakeRequest(req.body, req.headers["mcp-session-id"] as string | undefined);
      } catch {
        // A diagnostic must never fail a request.
      }
      next();
    },
    (req, res) => void handlePost(req, res),
  );
  app.get("/mcp", bearerAuth(deps.db), (req, res) => void handleSessionRequest(req, res));
  app.delete("/mcp", bearerAuth(deps.db), (req, res) => void handleSessionRequest(req, res));

  // A body express.json() refuses — over the limit, or not JSON — never reaches
  // bearerAuth, the probe, or the SDK, so before this it was the one request shape
  // that failed with NO server-side record: exactly the silent-failure class this
  // change exists to end. Express's default handler would also answer with an HTML
  // error page on a JSON-RPC endpoint. Only the error TYPE, the status, and the
  // declared content-length are recorded — the body is untrusted and unparsed, so
  // nothing from it is logged.
  app.use((error: unknown, req: Request, res: Response, next: (err?: unknown) => void) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const failure = error as { type?: string; status?: number; statusCode?: number };
    const status = failure.status ?? failure.statusCode ?? 400;
    mcpEvent("request_rejected", {
      path: req.path,
      reason: typeof failure.type === "string" ? failure.type : "unknown",
      status,
      contentLength: Number(req.headers["content-length"]) || 0,
    });
    res.status(status).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Bad Request: unreadable body" },
      id: null,
    });
  });

  return app;
}

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Deps } from "@cj/domain";
import { photoStorageFromEnv, type PhotoStorage } from "@cj/photos";
import { createMcpServer } from "./server.js";
import { bearerAuth } from "./auth.js";
import { jsonResponseEnabled } from "./config.js";
import { mcpEvent, logScalar } from "./logger.js";
import { describeRequestMeta, shapeOf } from "./photo-intake.js";
import type { McpSessions } from "./sessions.js";

// The JSON-RPC body limit for /mcp. See the note on the express.json() call below:
// this is an UNAUTHENTICATED memory budget, because the body is buffered before
// bearerAuth runs.
const MAX_BODY_BYTES = "100kb";

// The HTTP surface: GET /healthz and the Streamable HTTP MCP transport at /mcp
// (ADR-005). One transport per MCP session, keyed by the mcp-session-id the SDK
// assigns on initialize — the spike-proven shape. A fresh initialize with no
// session id creates a session and its own McpServer over @cj/domain. The live
// sessions sit in `McpSessions` (sessions.ts), which closes idle ones.
//
// An id that names no live session — expired, deleted, or minted by a pod that
// has since restarted — gets 404 on every method, never 400: the spec makes 404
// the signal that tells a client to re-initialize, and the body is the SDK's own
// (code -32001), so a client that matches on either recognizes it. A request with
// no session id at all stays a 400, as the spec asks.
const SESSION_NOT_FOUND = {
  jsonrpc: "2.0",
  error: { code: -32001, message: "Session not found" },
  id: null,
} as const;

function sessionNotFound(req: Request, res: Response, sessionId: string): void {
  // The id is caller-supplied (an authenticated caller: this runs after
  // bearerAuth), so it is bounded like every other correlation handle.
  mcpEvent("session_not_found", { method: req.method, sessionId: logScalar(sessionId) });
  res.status(404).json(SESSION_NOT_FOUND);
}

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
// Correlation handles and the two allow-listed client-identity values are bounded
// by `logScalar` (logger.ts) — the value is only ever used to join or separate log
// lines, so unbounded input is a liability.

function logPhotoIntakeRequest(
  body: unknown,
  sessionId: string | undefined,
  clientId: string | undefined,
): void {
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
      sessionId: logScalar(sessionId),
      rpcId: logScalar(rpc.id),
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
      // The two ALLOW-LISTED value exceptions on this record
      // (security-and-observability.md). Two ChatGPT surfaces reach this endpoint
      // under the same OAuth client with different `_meta` and different
      // forwarding behaviour — one has never forwarded a file, the other does —
      // and without these the records are indistinguishable, so "which surface
      // fails to forward?" is unanswerable. Both are bounded; no other `_meta`
      // value is ever logged.
      client: {
        id: clientId ?? null,
        userAgent:
          logScalar((call._meta as Record<string, unknown> | undefined)?.["openai/userAgent"]) ??
          null,
      },
    });
  }
}

// `sessions` holds the live MCP sessions and sweeps the idle ones; the caller
// constructs it and closes it with the HTTP server. `storage` is the photo object
// store (ADR-007), read once from the environment and shared across sessions; null
// when photos are unconfigured, in which case the photo tools return the contract
// `unavailable`. Injectable so tests can pass an in-memory store.
export function buildApp(
  deps: Deps,
  sessions: McpSessions,
  storage: PhotoStorage | null = photoStorageFromEnv(),
): express.Express {
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  async function handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const transport = sessions.use(sessionId, res);
      if (!transport) {
        sessionNotFound(req, res, sessionId);
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session; send an initialize request first" },
        id: null,
      });
      return;
    }
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: jsonResponseEnabled(),
      onsessioninitialized: (sid: string) => sessions.add(sid, transport),
    });
    // Set before connect(): the McpServer wraps whatever onclose it finds there.
    transport.onclose = () => {
      if (transport.sessionId) sessions.closed(transport.sessionId);
    };
    const server = createMcpServer(deps, storage);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async function handleSessionRequest(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
        id: null,
      });
      return;
    }
    const transport = sessions.use(sessionId, res);
    if (!transport) {
      sessionNotFound(req, res, sessionId);
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
        logPhotoIntakeRequest(
          req.body,
          req.headers["mcp-session-id"] as string | undefined,
          (req as Request & { auth?: { clientId?: string } }).auth?.clientId,
        );
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

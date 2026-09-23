// MCP transport sessions (issue #339): the `Mcp-Session-Id` sessions of the
// stateful Streamable HTTP transport (ADR-005) — not smoke sessions (ADR-016) and
// not web sign-in sessions. Each one holds a transport and its own McpServer in
// this process's memory, so the set has to be bounded. Until this module, only a
// client's DELETE removed a session, and most clients never send one (ChatGPT
// opens a session per tool call and abandons it), so the rest stayed until the
// pod restarted (issue #339: 67 opened and 27 closed over 34 hours, memory
// climbing toward the limit).
//
// A session is IDLE when no request for it is in flight and none has started or
// finished within the idle timeout. An open request — in practice the client's GET
// event stream, which the SDK keeps alive with comment frames every 15 s — means a
// client is still connected, so the sweep never cuts one. Idle sessions are closed
// once a minute; the next request carrying a closed session's id gets 404, which
// the spec defines as the signal to re-initialize.
//
// The sessions live only in this process, which is why the mcp controller runs a
// single replica: a second pod would answer 404 to every session the first one
// minted.

import type { ServerResponse } from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { sessionIdleTimeoutMs } from "./config.js";
import { mcpEvent } from "./logger.js";

/** How often idle sessions are swept and the live count is logged. */
export const SESSION_SWEEP_INTERVAL_MS = 60_000;

/** Why a session closed: its client sent DELETE, the sweep found it idle, or the
 *  server shut down. */
type CloseReason = "client" | "idle" | "shutdown";

interface Session {
  transport: StreamableHTTPServerTransport;
  /** Clock time the latest request for this session started or finished. */
  lastActivity: number;
  /** Requests for this session whose responses have not closed yet. */
  inFlight: number;
  /** Set just before this module closes the transport, so the close is logged
   *  with its cause; a transport closed by the client's DELETE has none. */
  closing?: CloseReason;
}

/** One sweep's count, as logged: sessions left, how many of those have a request
 *  in flight (a connected client), and how many the sweep closed. */
export interface SweepResult {
  live: number;
  connected: number;
  expired: number;
}

export interface McpSessionOptions {
  /** Close a session idle for this long. Default MCP_SESSION_IDLE_MINUTES (30). */
  idleTimeoutMs?: number;
  /** How often to sweep. Default SESSION_SWEEP_INTERVAL_MS. */
  sweepIntervalMs?: number;
  /** The clock the idle rule reads. Injectable so tests can age a session. */
  now?: () => number;
}

/** The live MCP sessions of one server. Constructing it starts the sweep timer;
 *  whoever constructs it closes it when the HTTP server closes. The timer is
 *  unref'd either way, so it can never be what keeps a process alive. */
export class McpSessions {
  readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;

  constructor(options: McpSessionOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? sessionIdleTimeoutMs();
    this.now = options.now ?? (() => Date.now());
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        // A sweep must never take the server down; the next tick tries again, and
        // a missing `session_sweep` line is what shows it is failing.
      }
    }, options.sweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Register a session the transport has just initialized. */
  add(sessionId: string, transport: StreamableHTTPServerTransport): void {
    this.sessions.set(sessionId, { transport, lastActivity: this.now(), inFlight: 0 });
    mcpEvent("session_initialized", { sessionId, live: this.sessions.size });
  }

  /** The transport for a request carrying `sessionId`, or undefined when the
   *  session is unknown or closed. A found session counts the request as activity
   *  from now until its response closes. */
  use(sessionId: string, res: ServerResponse): StreamableHTTPServerTransport | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.lastActivity = this.now();
    session.inFlight += 1;
    res.once("close", () => {
      session.inFlight -= 1;
      session.lastActivity = this.now();
    });
    return session.transport;
  }

  /** Forget a session whose transport has closed. Idempotent: the transport's
   *  onclose and this module's own close path may both call it. */
  closed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    mcpEvent("session_closed", {
      sessionId,
      reason: session.closing ?? "client",
      live: this.sessions.size,
    });
  }

  /** Close every idle session, then log and return the count. */
  sweep(): SweepResult {
    const now = this.now();
    let expired = 0;
    let connected = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.inFlight > 0) {
        connected += 1;
      } else if (now - session.lastActivity >= this.idleTimeoutMs) {
        this.end(sessionId, session, "idle");
        expired += 1;
      }
    }
    const result: SweepResult = { live: this.sessions.size, connected, expired };
    mcpEvent("session_sweep", { ...result });
    return result;
  }

  /** Stop sweeping and close every session. Safe to call more than once. */
  close(): void {
    clearInterval(this.timer);
    for (const [sessionId, session] of this.sessions) {
      this.end(sessionId, session, "shutdown");
    }
  }

  private end(sessionId: string, session: Session, reason: CloseReason): void {
    session.closing = reason;
    // Closing the transport ends any stream it still holds and fires its onclose,
    // which calls closed(). Calling closed() here as well keeps the map right
    // without depending on that callback running synchronously.
    session.transport.close().catch(() => {});
    this.closed(sessionId);
  }
}

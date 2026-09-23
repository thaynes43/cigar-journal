import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { sessionIdleTimeoutMs } from "./config.js";
import { McpSessions } from "./sessions.js";

// The registry on its own, on a hand-driven clock. The HTTP behavior (404s, the
// SDK client re-initializing, event streams) is covered over real HTTP in
// mcp.test.ts.

const IDLE_MS = 30 * 60_000;

function response(): ServerResponse {
  return new ServerResponse(new IncomingMessage(new Socket()));
}

describe("McpSessions", () => {
  let clock = 0;
  let sessions: McpSessions;

  function registry(): McpSessions {
    clock = 0;
    sessions = new McpSessions({
      idleTimeoutMs: IDLE_MS,
      sweepIntervalMs: 3_600_000,
      now: () => clock,
    });
    return sessions;
  }

  function open(): string {
    const sessionId = randomUUID();
    sessions.add(sessionId, new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID }));
    return sessionId;
  }

  afterEach(() => {
    sessions?.close();
    vi.restoreAllMocks();
  });

  it("does not count a request whose response closed before it was used", () => {
    // A client that hangs up during body parsing or auth: its response has
    // emitted 'close' already and never will again.
    vi.spyOn(console, "log").mockImplementation(() => {});
    registry();
    const sessionId = open();
    const res = response();
    res.destroy();

    expect(sessions.use(sessionId, res)).toBeDefined();
    expect(sessions.sweep()).toEqual({ live: 1, connected: 0, expired: 0 });
    clock += IDLE_MS;
    expect(sessions.sweep()).toEqual({ live: 0, connected: 0, expired: 1 });
  });

  it("starts the idle clock when the last open request closes, not when it began", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    registry();
    const sessionId = open();
    const stream = response();
    sessions.use(sessionId, stream); // a GET event stream, opened at 0

    clock += 2 * IDLE_MS;
    expect(sessions.sweep()).toEqual({ live: 1, connected: 1, expired: 0 });
    stream.emit("close"); // the client lets go an hour in

    clock += IDLE_MS - 1;
    expect(sessions.sweep()).toEqual({ live: 1, connected: 0, expired: 0 });
    clock += 1;
    expect(sessions.sweep()).toEqual({ live: 0, connected: 0, expired: 1 });
  });

  it("an unknown or closed id finds nothing", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    registry();
    expect(sessions.use(randomUUID(), response())).toBeUndefined();
    const sessionId = open();
    sessions.close();
    expect(sessions.use(sessionId, response())).toBeUndefined();
    expect(sessions.size).toBe(0);
  });

  it("sweeps on its own timer, which close() stops", async () => {
    sessions = new McpSessions({ idleTimeoutMs: IDLE_MS, sweepIntervalMs: 5 });
    const sweep = vi
      .spyOn(sessions, "sweep")
      .mockReturnValue({ live: 0, connected: 0, expired: 0 });
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(2));
    sessions.close();
    const calls = sweep.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sweep.mock.calls.length).toBe(calls);
  });

  it("reads the idle timeout from MCP_SESSION_IDLE_MINUTES, 30 minutes by default", () => {
    const saved = process.env.MCP_SESSION_IDLE_MINUTES;
    try {
      delete process.env.MCP_SESSION_IDLE_MINUTES;
      expect(sessionIdleTimeoutMs()).toBe(30 * 60_000);
      process.env.MCP_SESSION_IDLE_MINUTES = "5";
      expect(sessionIdleTimeoutMs()).toBe(5 * 60_000);
      sessions = new McpSessions();
      expect(sessions.idleTimeoutMs).toBe(5 * 60_000);
      for (const invalid of ["", "0", "-3", "soon"]) {
        process.env.MCP_SESSION_IDLE_MINUTES = invalid;
        expect(sessionIdleTimeoutMs()).toBe(30 * 60_000);
      }
    } finally {
      if (saved === undefined) delete process.env.MCP_SESSION_IDLE_MINUTES;
      else process.env.MCP_SESSION_IDLE_MINUTES = saved;
    }
  });
});

// The spike MCP server: exactly two tools over the TestValueStore, plus
// server-level instructions. This is a connectivity probe, not the product's
// six-tool cigar-journal surface (see docs/mcp/tool-contract.md).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { TestValueStore } from "./store.js";
import { log } from "./logger.js";

const INSTRUCTIONS =
  "This is a throwaway connectivity-test server for the Cigar Journal Phase 0 MCP spike. " +
  "It exposes one read tool (get_test_value) and one write tool (set_test_value) over a single shared string, " +
  "so a client's remote connection, tool discovery, read/write calls, and write-confirmation UX can be verified end to end. " +
  "It stores no real data and is not the cigar journal.";

function principal(auth: AuthInfo | undefined): string {
  if (!auth) return "anonymous (authless mode)";
  const email = (auth.extra as { email?: string } | undefined)?.email;
  const userId = (auth.extra as { userId?: string } | undefined)?.userId;
  return email ?? userId ?? auth.clientId;
}

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function createMcpServer(store: TestValueStore): McpServer {
  const server = new McpServer(
    { name: "cigar-journal-spike", version: "0.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "get_test_value",
    {
      title: "Get test value",
      description:
        "Return the currently stored test value, who set it, the server time, and a monotonic counter of how many times this tool has been called.",
      inputSchema: {},
      annotations: { readOnlyHint: true, title: "Get test value" },
    },
    async (_args, extra) => {
      const s = store.read();
      const payload = {
        value: s.value,
        setBy: s.setBy,
        setAt: s.setAt,
        caller: principal(extra.authInfo),
        serverTime: new Date().toISOString(),
        readCount: s.readCount,
      };
      log("tool", "get_test_value", { caller: payload.caller, readCount: payload.readCount });
      return jsonResult(payload);
    },
  );

  server.registerTool(
    "set_test_value",
    {
      title: "Set test value",
      description:
        "Store a new test value (persisted so restarts are visible) and return the previous and new value.",
      inputSchema: { value: z.string().describe("The new value to store.") },
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Set test value" },
    },
    async ({ value }, extra) => {
      const caller = principal(extra.authInfo);
      const { previous, current } = store.write(value, caller);
      log("tool", "set_test_value", { caller, previous, current });
      return jsonResult({ previous, current, setBy: caller, setAt: new Date().toISOString() });
    },
  );

  return server;
}

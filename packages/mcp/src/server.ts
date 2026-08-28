import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  saveSmoke,
  updateSmoke,
  getSmoke,
  queryMySmokes,
  searchCigars,
  getCigar,
  getMyInventory,
  UnauthenticatedError,
  UnauthorizedError,
  type Deps,
  type Principal,
  type SaveSmokeInput,
  type UpdateSmokeInput,
} from "@cj/domain";
import {
  SERVER_INFO,
  INSTRUCTIONS,
  PERSONAL_SCOPE,
  TOOL_SCOPES,
  type ToolName,
} from "./constants.js";
import type { McpAuthExtra } from "./auth.js";
import {
  searchCigarsSchema,
  getCigarSchema,
  getMySmokesSchema,
  getSmokeSchema,
  saveSmokeSchema,
  updateSmokeSchema,
  type SaveSmokeArgs,
  type UpdateSmokeArgs,
} from "./schemas.js";
import { jsonResult, errorResult, toErrorPayload, type ToolResult } from "./results.js";
import { smokeUrl } from "./config.js";
import { mcpEvent } from "./logger.js";

// The seven-tool cigar-journal surface (docs/mcp/tool-contract.md). A THIN adapter
// (ADR-005): every tool derives the principal from the token, calls the matching
// @cj/domain service — the single writer of Smokes, which owns all business rules
// and re-validates every input — and shapes the contract response. Authorization,
// identity, invariants, and validation all live below this layer.

interface AuthContext {
  principal: Principal;
  scopes: string[];
  clientId: string;
}

function authContext(authInfo: AuthInfo | undefined): AuthContext {
  const principal = (authInfo?.extra as McpAuthExtra | undefined)?.principal;
  // The bearer middleware guarantees a valid token before any tool runs; this is
  // a defensive backstop, surfaced as the contract's `unauthenticated`.
  if (!authInfo || !principal) throw new UnauthenticatedError();
  return { principal, scopes: authInfo.scopes, clientId: authInfo.clientId };
}

// Authoritative, per-tool scope enforcement. The bearer middleware already 403s
// a scope-short single request at the HTTP layer; this backstop re-checks inside
// the handler so no request shape (e.g. a JSON-RPC batch) can reach a tool
// without its scope. Reported as the contract's `unauthorized` (not retryable).
function assertToolScope(tool: ToolName, scopes: string[]): void {
  for (const required of TOOL_SCOPES[tool]) {
    if (!scopes.includes(required)) throw new UnauthorizedError();
  }
}

// Run a tool body with uniform auth, scope enforcement, logging, and contract
// error mapping. Domain errors become isError tool results the model can read
// and act on; nothing leaks (no SQL, stacks, secrets, or other users).
async function run(
  tool: ToolName,
  authInfo: AuthInfo | undefined,
  fn: (ctx: AuthContext, correlationId: string) => Promise<ToolResult>,
): Promise<ToolResult> {
  const correlationId = randomUUID();
  const started = Date.now();
  try {
    const ctx = authContext(authInfo);
    assertToolScope(tool, ctx.scopes);
    const result = await fn(ctx, correlationId);
    mcpEvent("tool_called", { tool, correlationId, latencyMs: Date.now() - started });
    return result;
  } catch (error) {
    const payload = toErrorPayload(error, correlationId);
    mcpEvent("tool_error", {
      tool,
      correlationId,
      code: payload.code,
      latencyMs: Date.now() - started,
    });
    return errorResult(payload);
  }
}

// Provenance is stamped server-side from the OAuth client — never from arguments
// (security-and-observability.md). Envelope/provenance fields are excluded from
// the idempotency fingerprint (@cj/domain fingerprint), so stamping them never
// affects replay detection.
function toSaveInput(args: SaveSmokeArgs, clientId: string, correlationId: string): SaveSmokeInput {
  // Shapes mirror the contract, which the domain input types were derived from;
  // the lone widening is a lenient `rating` (string|number) the domain re-checks.
  const base = args as unknown as Omit<SaveSmokeInput, "provenance" | "correlationId">;
  return {
    ...base,
    provenance: { source: "llm-conversation", client: clientId },
    correlationId,
  };
}

function toUpdateInput(
  args: UpdateSmokeArgs,
  clientId: string,
  correlationId: string,
): UpdateSmokeInput {
  return {
    clientRequestId: args.clientRequestId,
    smokeId: args.smokeId,
    expectedVersion: args.expectedVersion,
    // Same-object pass-through preserves key-presence semantics (explicit null
    // clears, omitted keeps); the domain re-validates every change op.
    changes: args.changes as unknown as UpdateSmokeInput["changes"],
    provenance: { source: "llm-conversation", client: clientId },
    correlationId,
  };
}

export function createMcpServer(deps: Deps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_cigars",
    {
      title: "Search cigars",
      description:
        "Resolve a conversational cigar mention to catalog entries by fuzzy (trigram) name match. Use when a cigar is named or asked about, not for the user's own history. Prefer the fullest name the user gave — a bare word or a single product token may not match. Read `guidance`: single_match (an exact catalog-name hit — proceed with it), brand_match (only a brand was named — ask for the line/vitola), multiple_matches (candidates but no exact hit — confirm the exact one with the user before saving), no_match (nothing matched — a described save_smoke creates the cigar; if the mention was partial/abbreviated, ask for the fuller name first so you don't create a duplicate).",
      inputSchema: searchCigarsSchema,
      annotations: { readOnlyHint: true, title: "Search cigars" },
    },
    (args, extra) =>
      run("search_cigars", extra.authInfo, async ({ principal, scopes }) => {
        const result = await searchCigars(deps, principal, {
          query: args.query,
          limit: args.limit,
        });
        const personal = scopes.includes(PERSONAL_SCOPE);
        const matches = result.matches.map((m) => ({
          cigarId: m.cigarId,
          canonicalName: m.canonicalName,
          brand: m.brand,
          line: m.line,
          vitola: m.vitola,
          type: m.type,
          verification: m.verification,
          // Personal field: present only when the token also carries journal:read.
          ...(personal ? { userSmokeCount: m.userSmokeCount } : {}),
        }));
        return jsonResult({ matches, guidance: result.guidance });
      }),
  );

  server.registerTool(
    "get_cigar",
    {
      title: "Get cigar",
      description:
        "Fetch full catalog detail (blend, vitola, origin) for one resolved cigar id. Use after search_cigars when factual specifics help the conversation.",
      inputSchema: getCigarSchema,
      annotations: { readOnlyHint: true, title: "Get cigar" },
    },
    (args, extra) =>
      run("get_cigar", extra.authInfo, async ({ principal, scopes }) => {
        const result = await getCigar(deps, principal, { cigarId: args.cigarId });
        const personal = scopes.includes(PERSONAL_SCOPE);
        // personalProfile is present (possibly null) only with journal:read;
        // otherwise the key is omitted entirely — data never exceeds scope.
        return jsonResult(
          personal
            ? { cigar: result.cigar, personalProfile: result.personalProfile }
            : { cigar: result.cigar },
        );
      }),
  );

  server.registerTool(
    "get_my_smokes",
    {
      title: "Get my smokes",
      description:
        "Search the authenticated user's own smoke history, newest first, as compact summaries. Use for comparisons like what they thought last time or what they have called bready. The `text` filter is full-text over journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim. When `text` is used, each result carries `matchedIn` (which prose field(s) hit) and `matchSnippet` (a short excerpt around the hit) so you can see why it matched without a follow-up get_smoke.",
      inputSchema: getMySmokesSchema,
      annotations: { readOnlyHint: true, title: "Get my smokes" },
    },
    (args, extra) =>
      run("get_my_smokes", extra.authInfo, async ({ principal }) => {
        const result = await queryMySmokes(deps, principal, {
          cigarId: args.cigarId,
          brand: args.brand,
          descriptor: args.descriptor,
          text: args.text,
          smokedAfter: args.smokedAfter,
          minRating: args.minRating ?? undefined,
          limit: args.limit,
        });
        // Map explicitly to the contract summary shape. `strength` and
        // `photoCount` are web-only fields on SmokeSummary (they feed journal-card
        // chrome) and are deliberately excluded here to keep this tool's payload
        // contract-stable. matchedIn/matchSnippet keep their conditional presence
        // (text queries only).
        const smokes = result.smokes.map((s) => ({
          smokeId: s.smokeId,
          cigar: s.cigar,
          smokedAt: s.smokedAt,
          rating: s.rating,
          liked: s.liked,
          descriptors: s.descriptors,
          summary: s.summary,
          ...(s.matchedIn !== undefined
            ? { matchedIn: s.matchedIn, matchSnippet: s.matchSnippet }
            : {}),
        }));
        return jsonResult({ smokes, totalMatches: result.totalMatches });
      }),
  );

  server.registerTool(
    "get_smoke",
    {
      title: "Get smoke",
      description:
        "Fetch the complete record of one of the user's smokes by id, with full progression and verbatim notes. Use for exact comparison or before a guarded correction.",
      inputSchema: getSmokeSchema,
      annotations: { readOnlyHint: true, title: "Get smoke" },
    },
    (args, extra) =>
      run("get_smoke", extra.authInfo, async ({ principal }) => {
        const smoke = await getSmoke(deps, principal, { smokeId: args.smokeId });
        return jsonResult({ smoke });
      }),
  );

  server.registerTool(
    "get_my_inventory",
    {
      title: "Get my inventory",
      description:
        "The user's current humidor holdings — what they own, how many remain, since when it has been aging, their own rating. Use when the user asks what to smoke or what they have.",
      annotations: { readOnlyHint: true, title: "Get my inventory" },
    },
    (extra) =>
      run("get_my_inventory", extra.authInfo, async ({ principal }) => {
        const result = await getMyInventory(deps, principal);
        // Map EXPLICITLY to a contract-stable payload. Each holding carries the
        // catalog cigar shape, the derived stock picture, and its purchase lots
        // (lot's purchaseId/notes are web-only and deliberately excluded here).
        const holdings = result.holdings.map((h) => ({
          cigar: h.cigar,
          remaining: h.remaining,
          totalAcquired: h.totalAcquired,
          smokedCount: h.smokedCount,
          agingSince: h.agingSince,
          myRating: h.myRating,
          lots: h.lots.map((l) => ({
            purchasedAt: l.purchasedAt,
            quantity: l.quantity,
            packaging: l.packaging,
            vendor: l.vendor,
            pricePerStick: l.pricePerStick,
            boxDate: l.boxDate,
            humidorAt: l.humidorAt,
          })),
        }));
        return jsonResult({ holdings, totalSticksRemaining: result.totalSticksRemaining });
      }),
  );

  server.registerTool(
    "save_smoke",
    {
      title: "Save smoke",
      description:
        "Persist one finished smoke, called once when the user signals the cigar is over — never per observation. Omit anything the user did not establish; sparse is correct.",
      inputSchema: saveSmokeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Save smoke",
      },
    },
    (args, extra) =>
      run("save_smoke", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await saveSmoke(deps, principal, toSaveInput(args, clientId, correlationId));
        return jsonResult({
          smoke: {
            smokeId: result.smoke.smokeId,
            version: result.smoke.version,
            url: smokeUrl(result.smoke.smokeId),
            cigar: {
              cigarId: result.smoke.cigar.cigarId,
              canonicalName: result.smoke.cigar.canonicalName,
              verification: result.smoke.cigar.verification,
            },
          },
          cigarCreated: result.cigarCreated,
          replayed: result.replayed,
        });
      }),
  );

  server.registerTool(
    "update_smoke",
    {
      title: "Update smoke",
      description:
        "Apply explicit, field-scoped corrections to an existing smoke (rating, cigar, appended stages). Batch related corrections from the same exchange into ONE call rather than issuing several — one clientRequestId per correction intent. Reuse the clientRequestId on retries; unlisted fields are never touched.",
      inputSchema: updateSmokeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Update smoke",
      },
    },
    (args, extra) =>
      run("update_smoke", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await updateSmoke(
          deps,
          principal,
          toUpdateInput(args, clientId, correlationId),
        );
        return jsonResult(result);
      }),
  );

  return server;
}

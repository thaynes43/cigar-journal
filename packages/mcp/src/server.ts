import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  saveSmoke,
  addCigar,
  recordPurchase,
  updateSmoke,
  getSmoke,
  queryMySmokes,
  searchCigars,
  getCigar,
  getMyInventory,
  setWant,
  setFavorite,
  addSmokePhoto,
  mintPhotoUploadToken,
  requestCigarEnrichment,
  updateCigar,
  recordPrice,
  UnauthenticatedError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
  type Deps,
  type Principal,
  type SaveSmokeInput,
  type UpdateSmokeInput,
  type AddCigarInput,
  type RecordPurchaseInput,
  type UpdateCigarInput,
  type RecordPriceInput,
} from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError, type PhotoStorage } from "@cj/photos";
import {
  SERVER_INFO,
  INSTRUCTIONS,
  PERSONAL_SCOPE,
  TOOL_SCOPES,
  ADD_SMOKE_PHOTO_META,
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
  addCigarSchema,
  recordPurchaseSchema,
  addSmokePhotoSchema,
  setWantSchema,
  setWantOutput,
  setFavoriteSchema,
  setFavoriteOutput,
  requestCigarEnrichmentSchema,
  requestCigarEnrichmentOutput,
  updateCigarSchema,
  updateCigarOutput,
  recordPriceSchema,
  recordPriceOutput,
  searchCigarsOutput,
  getCigarOutput,
  getMySmokesOutput,
  getSmokeOutput,
  getMyInventoryOutput,
  saveSmokeOutput,
  updateSmokeOutput,
  addCigarOutput,
  recordPurchaseOutput,
  addSmokePhotoOutput,
  type SaveSmokeArgs,
  type UpdateSmokeArgs,
  type AddCigarArgs,
  type RecordPurchaseArgs,
  type UpdateCigarArgs,
  type RecordPriceArgs,
} from "./schemas.js";
import { jsonResult, errorResult, toErrorPayload, type ToolResult } from "./results.js";
import { smokeUrl, uploadUrl } from "./config.js";
import { mcpEvent } from "./logger.js";

// The twelve-tool cigar-journal surface (docs/mcp/tool-contract.md). A THIN adapter
// (ADR-005): every tool derives the principal from the token, calls the matching
// @cj/domain service — the single writer of Smokes, which owns all business rules
// and re-validates every input — and shapes the contract response. Authorization,
// identity, invariants, and validation all live below this layer.

// ---- File intake (add_smoke_photo, ADR-007) --------------------------------
// ChatGPT attaches the user's image to the tool call. Per OpenAI's Apps SDK this
// requires DECLARING the file input: the `image` property (schemas.ts) listed in
// the tool-level `_meta["openai/fileParams"]` published in tools/list
// (ADD_SMOKE_PHOTO_META) — without the declaration ChatGPT forwards nothing.
// Two delivery shapes are accepted and normalized into one fetch path:
//   1. `image` ARGUMENT value — `{ download_url, file_id, mime_type?, file_name? }`
//      the client fills in for the declared file param (the standard Apps SDK path).
//   2. Request-level `_meta["openai/fileParams"]` — the same entry shape carried in
//      request metadata (the earlier, production-proven delivery). Kept working.
// In both, download_url is a SHORT-LIVED signed URL the server must fetch promptly.
// This is web-only — mobile uploads are broken upstream and a chat file URL pasted
// as text (e.g. chatgpt.com/...) is unreachable from outside ChatGPT — hence the
// mode-B upload link. Handle names track the MCP file-upload drafts SEP-2356/1306.

const ATTACHED_FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTACHED_BYTES = 20 * 1024 * 1024; // 20 MB

interface AttachedFile {
  downloadUrl: string;
  mimeType?: string;
}

// Parse `_meta["openai/fileParams"]` defensively: array or single object, unknown
// shapes treated as ABSENT (fall back to mode B — a weird shape never errors).
// Returns the first usable entry, or null when no image was attached.
function firstFileParam(meta: Record<string, unknown> | undefined): AttachedFile | null {
  if (!meta || typeof meta !== "object") return null;
  const raw = meta["openai/fileParams"];
  if (raw == null) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== "object") return null;
  const entry = first as Record<string, unknown>;
  const downloadUrl = entry.download_url;
  if (typeof downloadUrl !== "string" || downloadUrl.length === 0) return null;
  const mimeType = typeof entry.mime_type === "string" ? entry.mime_type : undefined;
  return { downloadUrl, mimeType };
}

// Parse the declared `image` ARGUMENT (the Apps SDK file-param path) with the same
// defensiveness as firstFileParam: any shape without a usable download_url is
// treated as ABSENT so a partial/odd object falls back to mode B, never errors.
// The file object may name its type as `mime_type`; other handle fields
// (file_id/file_name/name) are unused server-side — only the URL is fetched.
function fileFromArgument(image: unknown): AttachedFile | null {
  if (!image || typeof image !== "object") return null;
  const entry = image as Record<string, unknown>;
  const downloadUrl = entry.download_url;
  if (typeof downloadUrl !== "string" || downloadUrl.length === 0) return null;
  const mimeType = typeof entry.mime_type === "string" ? entry.mime_type : undefined;
  return { downloadUrl, mimeType };
}

// Fetch the attached image server-side: 15s timeout, 20MB cap enforced by both
// the content-length header and a streamed byte count (a lying/absent header can
// never blow past the cap). contentType prefers the entry's mime_type, then the
// response header. Any failure throws — mapped to the contract `unavailable` by
// the run() wrapper.
async function fetchAttachedImage(file: AttachedFile): Promise<{ bytes: Buffer; contentType: string }> {
  const res = await fetch(file.downloadUrl, {
    signal: AbortSignal.timeout(ATTACHED_FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok || !res.body) throw new UnavailableError();

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACHED_BYTES) throw new UnavailableError();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ATTACHED_BYTES) {
      await reader.cancel();
      throw new UnavailableError();
    }
    chunks.push(value);
  }

  const contentType =
    file.mimeType ?? res.headers.get("content-type") ?? "application/octet-stream";
  return { bytes: Buffer.concat(chunks), contentType };
}

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

function toAddCigarInput(args: AddCigarArgs, clientId: string, correlationId: string): AddCigarInput {
  return {
    clientRequestId: args.clientRequestId,
    // The described-cigar shape matches DescribedCigarInput; the domain re-checks it.
    cigar: args.cigar as unknown as AddCigarInput["cigar"],
    requestEnrichment: args.requestEnrichment,
    provenance: { source: "llm-conversation", client: clientId },
    correlationId,
  };
}

function toRecordPurchaseInput(
  args: RecordPurchaseArgs,
  clientId: string,
  correlationId: string,
): RecordPurchaseInput {
  return {
    clientRequestId: args.clientRequestId,
    // cigarRef union mirrors CigarRef; quantity/date/price leaves are domain-checked.
    cigar: args.cigar as unknown as RecordPurchaseInput["cigar"],
    quantity: args.quantity,
    purchasedAt: args.purchasedAt,
    packaging: args.packaging,
    boxDate: args.boxDate,
    humidorAt: args.humidorAt,
    pricePerStick: args.pricePerStick,
    vendorName: args.vendorName,
    notes: args.notes,
    provenance: { source: "llm-conversation", client: clientId },
    correlationId,
  };
}

function toUpdateCigarInput(
  args: UpdateCigarArgs,
  clientId: string,
  correlationId: string,
): UpdateCigarInput {
  return {
    clientRequestId: args.clientRequestId,
    cigarId: args.cigarId,
    // fields mirror UpdateCigarFields; the domain re-checks each leaf and gates
    // every write on null + unverified.
    fields: args.fields as unknown as UpdateCigarInput["fields"],
    provenance: { source: "llm-conversation", client: clientId },
    correlationId,
  };
}

function toRecordPriceInput(
  args: RecordPriceArgs,
  clientId: string,
  correlationId: string,
): RecordPriceInput {
  return {
    clientRequestId: args.clientRequestId,
    cigarId: args.cigarId,
    price: args.price,
    currency: args.currency,
    packaging: args.packaging,
    sticksPerPackage: args.sticksPerPackage,
    vendorName: args.vendorName,
    sourceName: args.sourceName,
    sourceUrl: args.sourceUrl,
    // null (from the lenient enum) → domain default retail.
    priceType: args.priceType ?? undefined,
    inStock: args.inStock,
    observedAt: args.observedAt,
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

export function createMcpServer(deps: Deps, storage: PhotoStorage | null): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    "search_cigars",
    {
      title: "Search cigars",
      description:
        "Resolve a conversational cigar mention to catalog entries by fuzzy (trigram) name match. Use when a cigar is named or asked about, not for the user's own history. Prefer the fullest name the user gave — a bare word or a single product token may not match. Read `guidance`: single_match (an exact catalog-name hit — proceed with it), brand_match (only a brand was named — ask for the line/vitola), multiple_matches (candidates but no exact hit — confirm the exact one with the user before saving), no_match (nothing matched — a described save_smoke creates the cigar; if the mention was partial/abbreviated, ask for the fuller name first so you don't create a duplicate).",
      inputSchema: searchCigarsSchema,
      outputSchema: searchCigarsOutput,
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
      outputSchema: getCigarOutput,
      annotations: { readOnlyHint: true, title: "Get cigar" },
    },
    (args, extra) =>
      run("get_cigar", extra.authInfo, async ({ principal, scopes }) => {
        const result = await getCigar(deps, principal, { cigarId: args.cigarId });
        const personal = scopes.includes(PERSONAL_SCOPE);
        // The enrichment hint and pricing summary are catalog-scoped (ADR-009) —
        // same for every viewer, so they ride the base payload under catalog:read.
        // personalProfile and the want/favorite overlays are present only with
        // journal:read; otherwise the keys are omitted entirely — data never
        // exceeds scope. The notes are web-detail display only and stay off the
        // tool payload.
        const base = {
          cigar: result.cigar,
          enrichment: result.enrichment,
          pricing: result.pricing,
        };
        return jsonResult(
          personal
            ? {
                ...base,
                personalProfile: result.personalProfile,
                wanted: result.wanted,
                favorited: result.favorited,
              }
            : base,
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
      outputSchema: getMySmokesOutput,
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
      outputSchema: getSmokeOutput,
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
      outputSchema: getMyInventoryOutput,
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
          consumedCount: h.consumedCount,
          overConsumed: h.overConsumed,
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
        "Persist one finished smoke, called once when the user signals the cigar is over — never per observation. Omit anything the user did not establish; sparse is correct. When you pass a consumption block (the ask-once 'From your humidor?' beat), the result adds holdingAfter { totalAcquired, remaining } so you can confirm the new count without another read.",
      inputSchema: saveSmokeSchema,
      outputSchema: saveSmokeOutput,
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
          // Present only when a consumption block was supplied (ADR-008): the
          // derived stock after the deduction, mirroring record_purchase's
          // holdingAfter. Additive — undefined serializes away when absent.
          holdingAfter: result.holdingAfter,
          replayed: result.replayed,
        });
      }),
  );

  server.registerTool(
    "add_cigar",
    {
      title: "Add cigar",
      description:
        "The user names a cigar missing from the catalog. Confirm the fullest name first (search_cigars guidance applies); the entry is created unverified from their words and a background enrichment request is queued to fill specs and a product photo. Use before save_smoke or record_purchase when nothing matches. `guidance` is 'created' for a new entry or 'already_existed' when the name linked to an existing one.",
      inputSchema: addCigarSchema,
      outputSchema: addCigarOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Add cigar",
      },
    },
    (args, extra) =>
      run("add_cigar", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await addCigar(deps, principal, toAddCigarInput(args, clientId, correlationId));
        return jsonResult({
          cigar: result.cigar,
          created: result.created,
          enrichmentQueued: result.enrichmentQueued,
          guidance: result.created ? "created" : "already_existed",
          replayed: result.replayed,
        });
      }),
  );

  server.registerTool(
    "record_purchase",
    {
      title: "Record purchase",
      description:
        "Append an acquisition to the humidor ledger, or correct the count. quantity is a positive integer for a purchase; it may be NEGATIVE to correct an over-count — say why in notes. Record only stated facts (never invent a price, date, or vendor); a described cigar with no catalog match is auto-created and its enrichment queued. Corrections are rows too — holdings stay derived. Output: purchaseId, cigar, holdingAfter { totalAcquired, remaining }, and wanted — when wanted is true the user just bought something on their want list, so offer to clear it with set_want (never clear it silently).",
      inputSchema: recordPurchaseSchema,
      outputSchema: recordPurchaseOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Record purchase",
      },
    },
    (args, extra) =>
      run("record_purchase", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await recordPurchase(
          deps,
          principal,
          toRecordPurchaseInput(args, clientId, correlationId),
        );
        return jsonResult({
          purchaseId: result.purchaseId,
          cigar: result.cigar,
          holdingAfter: result.holdingAfter,
          // Acquisition never auto-clears a want (R-WANT-2); this flag lets the
          // model OFFER the clear via set_want. Never silent.
          wanted: result.wanted,
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
      outputSchema: updateSmokeOutput,
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

  server.registerTool(
    "add_smoke_photo",
    {
      title: "Add smoke photo",
      description:
        "Attach a photo to one of the user's smokes. The image is never a text argument — provide it one of two ways and the tool auto-detects which:\n" +
        "1. ATTACH THE IMAGE TO THIS TOOL CALL. When the user has shared a photo, attach that image directly to this call so the host carries it as file data; the server fetches it, strips location metadata, and files it under the smoke. Do NOT paste an image or a chat file link (e.g. a chatgpt.com/... URL) into any field — those links are unreachable outside the chat and will fail.\n" +
        "2. NO IMAGE? Call with just the smoke id; the tool returns a one-time upload link. Hand it to the user: open it on your phone, it goes straight to your camera roll and attaches to this smoke. This is the reliable path on mobile, where in-chat photo attachment does not work.\n" +
        "A photo NEVER blocks save_smoke — it is a separate action with its own result, so a photo failure never affects saving the smoke. `kind` classifies the shot (cigar, band, construction, burn, other; default other); add a `caption` only if the user gave one.",
      inputSchema: addSmokePhotoSchema,
      outputSchema: addSmokePhotoOutput,
      // Declare `image` as a file input so ChatGPT forwards the attached photo.
      _meta: ADD_SMOKE_PHOTO_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        title: "Add smoke photo",
      },
    },
    (args, extra) =>
      run("add_smoke_photo", extra.authInfo, async ({ principal }, correlationId) => {
        // Photos disabled cluster-wide → the whole tool is non-functional; report
        // `unavailable` rather than mint a link that would 503 on upload.
        if (!storage) throw new UnavailableError();

        // Two accepted deliveries → one fetch path: the declared `image` argument
        // (Apps SDK file param) and the production-proven request-level
        // `_meta["openai/fileParams"]`. Either yields an AttachedFile or null
        // (→ mode B); a malformed shape in either is treated as absent, never errors.
        const meta = extra._meta as Record<string, unknown> | undefined;
        const attached = firstFileParam(meta) ?? fileFromArgument(args.image);

        if (attached) {
          // Mode A — image attached: fetch it, run the shared pipeline, store it.
          const { bytes, contentType } = await fetchAttachedImage(attached);
          let processed;
          try {
            processed = await processPhoto(bytes, contentType);
          } catch (error) {
            // A present-but-undecodable image is the model's to fix by attaching a
            // supported one — surface it as a structured validation_error.
            if (error instanceof UnsupportedImageTypeError) {
              throw new ValidationError([
                { path: "image", message: "Unsupported or unreadable image." },
              ]);
            }
            throw error;
          }
          const photo = await addSmokePhoto(deps, storage, principal, {
            smokeId: args.smokeId,
            kind: args.kind,
            caption: args.caption ?? null,
            image: {
              full: processed.full,
              thumb: processed.thumb,
              contentType: processed.contentType,
              width: processed.width,
              height: processed.height,
              bytes: processed.full.byteLength,
            },
            actor: "mcp",
            correlationId,
          });
          return jsonResult({ mode: "attached", photo });
        }

        // Mode B — no image: mint a short-lived, single-use upload link bound to
        // (user, smoke, kind?, caption?) for the user to open on their phone.
        const minted = await mintPhotoUploadToken(deps, principal, {
          smokeId: args.smokeId,
          kind: args.kind,
          caption: args.caption ?? null,
          correlationId,
        });
        return jsonResult({
          mode: "upload_url",
          uploadUrl: uploadUrl(minted.token),
          expiresAt: minted.expiresAt,
        });
      }),
  );

  server.registerTool(
    "set_want",
    {
      title: "Set want",
      description:
        "Mark a catalog cigar as wanted, or clear the mark. Wanting is independent of owning or smoking it — smoking never clears a want, and it is cleared only on request. Set `wanted` true to mark, false to clear; add a `note` only if the user gave a reason. Idempotent: repeating a call is a safe no-op (no clientRequestId needed). Output: cigarId, wanted, note, changed.",
      inputSchema: setWantSchema,
      outputSchema: setWantOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Set want",
      },
    },
    (args, extra) =>
      run("set_want", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await setWant(deps, principal, {
          cigarId: args.cigarId,
          wanted: args.wanted,
          note: args.note,
          provenance: { source: "llm-conversation", client: clientId },
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "set_favorite",
    {
      title: "Set favorite",
      description:
        "Mark a catalog cigar as a favorite — one the user loves — or clear the mark. A favorite is distinct from a want and independent of owning or smoking; it is never inferred from a smoke's liked signal, only set when the user asks (\"add it to my favorites\"). Set `favorited` true to mark, false to clear; add a `note` only if the user gave a reason. Idempotent: repeating a call is a safe no-op (no clientRequestId needed). Output: cigarId, favorited, note, changed.",
      inputSchema: setFavoriteSchema,
      outputSchema: setFavoriteOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Set favorite",
      },
    },
    (args, extra) =>
      run("set_favorite", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await setFavorite(deps, principal, {
          cigarId: args.cigarId,
          favorited: args.favorited,
          note: args.note,
          provenance: { source: "llm-conversation", client: clientId },
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "request_cigar_enrichment",
    {
      title: "Request cigar enrichment",
      description:
        "Queue a background lookup to fill an EXISTING sparse cigar's specs and a product photo (ADR-009). Use when get_cigar shows an enrichment hint with missing fields. It never creates a cigar and never touches the journal. Idempotent: repeating is safe (no clientRequestId needed). `status` is queued (a request was enqueued), already_queued (one is pending), recently_enriched (the crawler recently filled it), or not_needed (already complete); `missingFields` lists the gaps and `verification` the current trust state.",
      inputSchema: requestCigarEnrichmentSchema,
      outputSchema: requestCigarEnrichmentOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Request cigar enrichment",
      },
    },
    (args, extra) =>
      run("request_cigar_enrichment", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await requestCigarEnrichment(deps, principal, {
          cigarId: args.cigarId,
          provenance: { source: "llm-conversation", client: clientId },
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "update_cigar",
    {
      title: "Update cigar",
      description:
        "Fill blank factual fields on an existing catalog cigar from what the user knows (ADR-009). Fill-nulls-only: a field is written ONLY when it is currently blank AND the cigar is unverified — chat never overwrites an existing value or a curator-verified entry, and never touches the journal. Pass only the fields you can fill. Output: changedFields (written), skipped (provided but already set or verified-locked), verification. Reuse the clientRequestId on retries.",
      inputSchema: updateCigarSchema,
      outputSchema: updateCigarOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Update cigar",
      },
    },
    (args, extra) =>
      run("update_cigar", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await updateCigar(deps, principal, toUpdateCigarInput(args, clientId, correlationId));
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "record_price",
    {
      title: "Record price",
      description:
        "Log a price you found or the user reported for a catalog cigar (ADR-009). Give the packaging it was priced at (single, 5-pack, box of 20) and sticksPerPackage so per-stick is computed — never state a per-stick figure without its packaging. Name the vendor when it is a known shop; otherwise give a sourceName (and sourceUrl) — a source is required. Record only stated facts: never invent a price. An identical price re-seen within a day is skipped (deduped:true, recorded:false); a changed price is always kept. Reuse the clientRequestId on retries.",
      inputSchema: recordPriceSchema,
      outputSchema: recordPriceOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Record price",
      },
    },
    (args, extra) =>
      run("record_price", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await recordPrice(deps, principal, toRecordPriceInput(args, clientId, correlationId));
        return jsonResult(result);
      }),
  );

  return server;
}

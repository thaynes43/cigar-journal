import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  saveSmoke,
  addCigar,
  recordPurchase,
  recordPurchaseBatch,
  updateSmoke,
  getSmoke,
  queryMySmokes,
  searchCigars,
  getCigar,
  browseCatalog,
  getCigarOffers,
  getCigarOfferHistory,
  getMyInventory,
  setWant,
  setFavorite,
  addSmokePhoto,
  mintPhotoUploadToken,
  openPhotoDrop,
  claimPhotoDrop,
  stagePhotoByToken,
  requestCigarEnrichment,
  updateCigar,
  recordPrice,
  curationWorklist,
  setListingMatchStatus,
  setCigarFacts,
  verifyCigar,
  excludeCigar,
  restoreCigar,
  setProductPhotoRights,
  renameCigar,
  queueEnrichmentBacklog,
  registerTaxonomy,
  updateRegistryAliases,
  renameRegistryEntity,
  assignCigarTaxonomy,
  splitCigar,
  UnauthenticatedError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
  PhotoDropNotFoundError,
  type Deps,
  type Principal,
  type SaveSmokeInput,
  type UpdateSmokeInput,
  type AddCigarInput,
  type RecordPurchaseInput,
  type RecordPurchaseBatchInput,
  type UpdateCigarInput,
  type RecordPriceInput,
  type CurationAttribution,
  type ProcessedImage,
} from "@cj/domain";
import { processPhoto, type PhotoStorage } from "@cj/photos";
import {
  SERVER_INFO,
  INSTRUCTIONS,
  PERSONAL_SCOPE,
  TOOL_SCOPES,
  PHOTO_FILE_PARAMS_META,
  type ToolName,
} from "./constants.js";
import type { McpAuthExtra } from "./auth.js";
import {
  searchCigarsSchema,
  getCigarSchema,
  browseCatalogSchema,
  browseCatalogOutput,
  getOffersSchema,
  getOffersOutput,
  getMySmokesSchema,
  getSmokeSchema,
  saveSmokeSchema,
  updateSmokeSchema,
  addCigarSchema,
  recordPurchaseSchema,
  recordPurchaseBatchSchema,
  addSmokePhotoSchema,
  openPhotoDropSchema,
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
  getCurationQueueSchema,
  getCurationQueueOutput,
  setListingMatchStatusSchema,
  setListingMatchStatusOutput,
  setCigarFactsSchema,
  setCigarFactsOutput,
  verifyCigarSchema,
  verifyCigarOutput,
  excludeCigarSchema,
  restoreCigarSchema,
  setCatalogStatusOutput,
  setProductPhotoRightsSchema,
  setProductPhotoRightsOutput,
  renameCigarSchema,
  renameCigarOutput,
  queueEnrichmentBacklogSchema,
  registerTaxonomySchema,
  registerTaxonomyOutput,
  updateRegistryAliasesSchema,
  updateRegistryAliasesOutput,
  renameRegistryEntitySchema,
  renameRegistryEntityOutput,
  assignCigarTaxonomySchema,
  assignCigarTaxonomyOutput,
  splitCigarSchema,
  splitCigarOutput,
  queueEnrichmentBacklogOutput,
  searchCigarsOutput,
  getCigarOutput,
  getMySmokesOutput,
  getSmokeOutput,
  getMyInventoryOutput,
  saveSmokeOutput,
  updateSmokeOutput,
  addCigarOutput,
  recordPurchaseOutput,
  recordPurchaseBatchOutput,
  addSmokePhotoOutput,
  openPhotoDropOutput,
  type SaveSmokeArgs,
  type UpdateSmokeArgs,
  type AddCigarArgs,
  type RecordPurchaseArgs,
  type RecordPurchaseBatchArgs,
  type UpdateCigarArgs,
  type RecordPriceArgs,
} from "./schemas.js";
import {
  classify,
  describeArgument,
  describeRequestMeta,
  fetchTargetOf,
  resolveContentType,
  MAX_ATTACHED_BYTES,
  type Channel,
  type UnusableReason,
} from "./photo-intake.js";
import { jsonResult, errorResult, toErrorPayload, type ToolResult } from "./results.js";
import { smokeUrl, uploadUrl, dropUrl } from "./config.js";
import { mcpEvent } from "./logger.js";

// The thirty-three-tool cigar-journal surface (docs/mcp/tool-contract.md). A THIN adapter
// (ADR-005): every tool derives the principal from the token, calls the matching
// @cj/domain service — the single writer of Smokes, which owns all business rules
// and re-validates every input — and shapes the contract response. Authorization,
// identity, invariants, and validation all live below this layer.

// ---- File intake (add_smoke_photo / open_photo_drop, ADR-007, ADR-014) -----
// ChatGPT attaches the user's image to the tool call. Per OpenAI's Apps SDK this
// requires DECLARING the file input: the `image` property (schemas.ts) listed in
// the tool-level `_meta["openai/fileParams"]` published in tools/list
// (PHOTO_FILE_PARAMS_META) — without the declaration ChatGPT forwards nothing.
// Both photo tools declare it and share one intake path (intakePhoto below).
// Two delivery shapes are accepted and normalized into one intake path:
//   1. `image` ARGUMENT value — `{ download_url, file_id, mime_type?, file_name? }`
//      the client fills in for the declared file param (the standard Apps SDK path).
//   2. Request-level `_meta["openai/fileParams"]` — the same entry shape carried in
//      request metadata (the earlier, production-proven delivery). Kept working.
// A download_url is a SHORT-LIVED signed URL the server must fetch promptly. This
// is web-only — mobile uploads are broken upstream and a chat file URL pasted as
// text (e.g. chatgpt.com/...) is unreachable from outside ChatGPT — hence the
// mode-B link. Inline base64 delivery is deliberately NOT accepted; the reason is
// in photo-intake.ts, and it is a body-size one, not a taste one.
//
// EVERY failure here falls back to mode B and is RECORDED, never raised. Classification
// lives in photo-intake.ts; this file does the I/O and writes the `photo_intake` record.

const ATTACHED_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

// Why the attached image did not get filed — the diagnostic vocabulary the owner
// asked for, one value per distinguishable cause. Before this, "no image sent" and
// "a handle arrived with no download_url" were byte-identical in the logs.
//   no_delivery         nothing arrived on either channel
//   not_an_object       `image` was a string/number/null, not a file handle
//   no_url              a handle arrived (e.g. { file_id, mime_type }) with nothing fetchable
//   empty_url           a URL key was present but blank
//   bad_scheme          the reference failed the SSRF guard (not https to a public
//                       host), INCLUDING a redirect that tried to escape it
//   fetch_failed        the URL was fetched and failed (non-2xx, timeout, transport,
//                       a missing Location, or too many hops)
//   too_large           the response exceeded 20MB
//   unreadable          bytes arrived but are not a supported, decodable image
//   attached            the image arrived and decoded (the storage write follows)
//   storage_unavailable photos are unconfigured cluster-wide; the tool is non-functional
type IntakeOutcome =
  | "attached"
  | "no_delivery"
  | UnusableReason
  | "fetch_failed"
  | "too_large"
  | "unreadable"
  | "storage_unavailable";

// The MODEL-VISIBLE half of the diagnosis, deliberately coarser than the log
// vocabulary: it must never name a URL, a host, a key, or a file id, because
// everything here can be read back to the user. Four statuses, because that is the
// number of distinct things a model can usefully DO about it.
type DeliveryStatus =
  | "no_image_received"
  | "image_reference_unusable"
  | "image_fetch_failed"
  | "image_unreadable";

// `no_image_received` is the EXPECTED outcome, not a failure, and the detail now
// says so (#288). No current client forwards a chat attachment to this server —
// three `open_photo_drop` calls on 2026-09-03 carried `argKeys []` and
// `metaFileParams absent, count 0`, the third live data point with the same
// signature — so a model that reads the old sentence as a fault reports a
// problem to the user and delays the one thing that works: relaying the link.
const DELIVERY_DETAIL: Record<DeliveryStatus, string> = {
  no_image_received:
    "No image arrived with this call. Chat attachments are not forwarded to this server by any current client, so the upload link is the path — relay it. This is the expected outcome, not a failure.",
  image_reference_unusable: "An image reference arrived, but it carried nothing the server can read.",
  image_fetch_failed: "An image reference arrived, but the image could not be retrieved.",
  image_unreadable: "An image arrived, but it is not a readable photo.",
};

function deliveryFor(outcome: IntakeOutcome): { status: DeliveryStatus; detail: string } | undefined {
  switch (outcome) {
    case "no_delivery":
      return { status: "no_image_received", detail: DELIVERY_DETAIL.no_image_received };
    case "not_an_object":
    case "no_url":
    case "empty_url":
    case "bad_scheme":
      return { status: "image_reference_unusable", detail: DELIVERY_DETAIL.image_reference_unusable };
    case "fetch_failed":
    case "too_large":
      return { status: "image_fetch_failed", detail: DELIVERY_DETAIL.image_fetch_failed };
    case "unreadable":
      return { status: "image_unreadable", detail: DELIVERY_DETAIL.image_unreadable };
    default:
      return undefined;
  }
}

// The fetch half of the `photo_intake` record. `host` is the ONE place the record
// touches a value from a handle: the hostname is not the credential (the path and
// query are) and it is the only way to tell an egress block from an upstream 403.
interface FetchRecord {
  host: string;
  scheme: string;
  status?: number;
  ms: number;
  timedOut: boolean;
  redirects?: number;
  // Why a redirect chain ended without a body. Without this, "the guard bit at a
  // hop" was indistinguishable from "the host sent no Location" and "the chain
  // was too long" — all three collapsed into a bare `fetch_failed`, and the first
  // is a security event while the other two are upstream noise.
  redirectFailure?: "scheme_refused" | "no_location" | "too_many_hops";
  declaredType?: string;
  sniffedType?: string;
  bytes?: number;
}

interface FetchResult {
  bytes?: Buffer;
  headerType?: string;
  record: FetchRecord;
  failure?: "fetch_failed" | "too_large" | "bad_scheme";
}

// Fetch the attached image server-side. NEVER throws: a failure is a FALLBACK
// (mode B still works) plus a diagnostic record, not a tool error the user never
// sees. 15s timeout; the 20MB cap is enforced by both the content-length header
// and a streamed byte count, so a lying/absent header cannot blow past it.
//
// Redirects are followed MANUALLY, at most three hops, revalidating the scheme
// guard on every hop: `download_url` is a model-writable argument, so an
// auto-followed redirect would otherwise be a free bypass of that guard
// (https://attacker/ → http://10.0.0.1/).
async function fetchAttachedImage(target: {
  url: string;
  scheme: string;
  host: string;
}): Promise<FetchResult> {
  const started = Date.now();
  const record: FetchRecord = { host: target.host, scheme: target.scheme, ms: 0, timedOut: false };
  let url = target.url;
  // ONE signal for the whole exchange, redirects included — a per-hop timeout
  // would let a redirect chain stretch the 15s budget to four times that.
  const signal = AbortSignal.timeout(ATTACHED_FETCH_TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop += 1) {
      const res = await fetch(url, { signal, redirect: "manual" });
      record.status = res.status;

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        const next = location ? redirectTarget(url, location) : null;
        // Release the redirect's own body rather than leaving the socket held.
        await res.body?.cancel();
        if (!next || hop >= MAX_REDIRECTS) {
          record.ms = Date.now() - started;
          record.redirects = hop;
          // A hop the guard refused is reported as `bad_scheme`, not `fetch_failed`:
          // it is an attempted SSRF escape (https://host/ -> http://169.254.169.254/),
          // and it must be greppable as one rather than buried among timeouts.
          if (!location) {
            record.redirectFailure = "no_location";
            return { record, failure: "fetch_failed" };
          }
          if (!next) {
            record.redirectFailure = "scheme_refused";
            return { record, failure: "bad_scheme" };
          }
          record.redirectFailure = "too_many_hops";
          return { record, failure: "fetch_failed" };
        }
        url = next.url;
        record.host = next.host;
        record.scheme = next.scheme;
        record.redirects = hop + 1;
        continue;
      }

      if (!res.ok || !res.body) {
        await res.body?.cancel();
        record.ms = Date.now() - started;
        return { record, failure: "fetch_failed" };
      }

      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_ATTACHED_BYTES) {
        record.ms = Date.now() - started;
        record.bytes = declared;
        return { record, failure: "too_large" };
      }

      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_ATTACHED_BYTES) {
          await reader.cancel();
          record.ms = Date.now() - started;
          record.bytes = total;
          return { record, failure: "too_large" };
        }
        chunks.push(value);
      }

      record.ms = Date.now() - started;
      record.bytes = total;
      return {
        bytes: Buffer.concat(chunks),
        headerType: res.headers.get("content-type") ?? undefined,
        record,
      };
    }
  } catch (error) {
    record.ms = Date.now() - started;
    // undici raises the AbortSignal.timeout as a TimeoutError; distinguishing it
    // from a connection refusal is the difference between "the signed URL expired
    // slowly" and "egress is blocked".
    record.timedOut = error instanceof Error && error.name === "TimeoutError";
    return { record, failure: "fetch_failed" };
  }
}

// The intake BOTH photo tools run (ADR-014 put a second tool on this path).
// Describe both channels, classify, fetch under the SSRF guard, decode, and write
// the ONE `photo_intake` line that says what arrived. Shared rather than copied
// because a second copy would be a second vocabulary: the diagnostics only answer
// "why did this call not attach a photo" while every call is describable in the
// same terms. `tool` names the caller in the record, so the two are separable in
// Loki with every other field identical.
interface PhotoIntake {
  // The object store, proven configured. Handed back rather than re-checked by
  // the caller: `storage_unavailable` must be RECORDED before it throws, so the
  // check belongs here — and returning the narrowed store means a handler cannot
  // forget it.
  storage: PhotoStorage;
  // The normalized image, present only when one arrived and decoded.
  image?: ProcessedImage;
  // Why there is none, in the model-visible vocabulary. Absent when `image` is.
  delivery?: { status: DeliveryStatus; detail: string };
}

async function intakePhoto(args: {
  tool: "open_photo_drop" | "add_smoke_photo";
  image: unknown;
  requestMeta: Record<string, unknown> | undefined;
  storage: PhotoStorage | null;
  correlationId: string;
  sessionId: string | undefined;
  rpcId: string | number | undefined;
}): Promise<PhotoIntake> {
  const startedAt = Date.now();

  // Describe BOTH channels before deciding anything. Whatever else the call does,
  // the record must be able to say what arrived — "nothing was sent" and "a handle
  // arrived carrying { file_id, mime_type }" were once indistinguishable from
  // outside.
  const argument = describeArgument(args.image);
  const requestMetaShape = describeRequestMeta(args.requestMeta);

  // Exactly one `photo_intake` line per call, joined to the HTTP-layer
  // `photo_intake_request` line on (sessionId, rpcId), and to `tool_called` /
  // `tool_error` on correlationId.
  const record = (
    outcome: IntakeOutcome,
    mode: "attached" | "upload_url" | "unavailable",
    channel: Channel,
    extras: { urlKey?: string; fetch?: FetchRecord; decodeError?: string } = {},
  ): void => {
    mcpEvent("photo_intake", {
      tool: args.tool,
      correlationId: args.correlationId,
      sessionId: args.sessionId,
      rpcId: args.rpcId,
      outcome,
      channel,
      mode,
      argument,
      requestMeta: requestMetaShape,
      ...extras,
      latencyMs: Date.now() - startedAt,
    });
  };

  // Photos disabled cluster-wide → the calling tool is non-functional; report
  // `unavailable` rather than mint a link that would 503 on upload. Recorded
  // first so this stays distinguishable from a delivery problem.
  if (!args.storage) {
    record("storage_unavailable", "unavailable", "none");
    throw new UnavailableError();
  }

  const delivery = classify(args.image, args.requestMeta);
  const channel: Channel = delivery.kind === "absent" ? "none" : delivery.channel;

  // Turn the classified delivery into bytes, or into the reason there are none.
  // Nothing below throws for a delivery problem: a link is the guaranteed path on
  // both tools, so a failure becomes a link plus a record.
  let outcome: IntakeOutcome;
  let bytes: Buffer | undefined;
  let declaredType: string | undefined;
  let fetchRecord: FetchRecord | undefined;
  let urlKey: string | undefined;

  switch (delivery.kind) {
    case "absent":
      outcome = "no_delivery";
      break;
    case "unusable":
      outcome = delivery.reason;
      break;
    case "fetchable": {
      urlKey = delivery.urlKey;
      const fetched = await fetchAttachedImage(delivery);
      fetchRecord = fetched.record;
      if (fetched.failure || !fetched.bytes) {
        outcome = fetched.failure ?? "fetch_failed";
      } else {
        bytes = fetched.bytes;
        // The handle's own mime_type wins over the response header — the host
        // knows what the user attached; the origin often says nothing.
        declaredType = delivery.mimeType ?? fetched.headerType;
        outcome = "attached";
      }
      break;
    }
  }

  let processed: Awaited<ReturnType<typeof processPhoto>> | undefined;
  let decodeError: string | undefined;
  if (bytes) {
    // Bytes only ever come from a fetch, so the type resolution always has a
    // fetch record to land in (inline delivery was removed — photo-intake.ts).
    const resolved = resolveContentType(declaredType, bytes);
    if (fetchRecord) {
      fetchRecord.declaredType = resolved.declaredType;
      fetchRecord.sniffedType = resolved.sniffedType;
    }
    try {
      processed = await processPhoto(bytes, resolved.contentType);
    } catch (error) {
      // The error CLASS only — never its message, which can echo input.
      // UnsupportedImageTypeError means the type was refused up front; any other
      // name means the decoder itself gave up on the bytes.
      decodeError = error instanceof Error ? error.name : "unknown";
      // Bytes that will not decode are a FALLBACK, not an error: the user gets a
      // working link and the reason lives in the record. UnsupportedImageTypeError
      // and a decoder fault are one outcome here because they are one thing to the
      // user: unusable bytes.
      outcome = "unreadable";
    }
  }

  const extras = {
    ...(urlKey !== undefined ? { urlKey } : {}),
    ...(fetchRecord ? { fetch: fetchRecord } : {}),
    ...(decodeError !== undefined ? { decodeError } : {}),
  };

  if (processed) {
    // `outcome: attached` describes INTAKE, not the storage write: it is recorded
    // BEFORE the caller files the photo, so the intake story is complete even when
    // that write then fails (smoke_not_found, photo_limit) — that failure arrives
    // as `tool_error` under the same correlationId.
    record("attached", "attached", channel, extras);
    return {
      storage: args.storage,
      image: {
        full: processed.full,
        thumb: processed.thumb,
        contentType: processed.contentType,
        width: processed.width,
        height: processed.height,
        bytes: processed.full.byteLength,
      },
    };
  }

  record(outcome, "upload_url", channel, extras);
  return { storage: args.storage, delivery: deliveryFor(outcome) };
}

// Resolve one redirect hop against the same scheme guard the first request passed.
function redirectTarget(from: string, location: string): { url: string; scheme: string; host: string } | null {
  let resolved: URL;
  try {
    resolved = new URL(location, from);
  } catch {
    return null;
  }
  const target = fetchTargetOf(resolved.toString());
  return target ? { url: resolved.toString(), ...target } : null;
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

// Authoritative, per-tool scope enforcement (ANY-of: holding at least one of the
// tool's listed scopes authorizes it — TOOL_SCOPES). Every tool lists exactly one
// scope except get_cigar (catalog:read OR curation:read), so this is "require that
// scope" for all but that one. The bearer middleware already 403s a scope-short
// single request at the HTTP layer; this backstop re-checks inside the handler so
// no request shape (e.g. a JSON-RPC batch) can reach a tool without a qualifying
// scope. Reported as the contract's `unauthorized` (not retryable).
function assertToolScope(tool: ToolName, scopes: string[]): void {
  const accepted = TOOL_SCOPES[tool];
  if (accepted.length > 0 && !accepted.some((required) => scopes.includes(required))) {
    throw new UnauthorizedError();
  }
}

// The admin gate for the curation surface (DESIGN-003 wave 4a). Scope is necessary
// but not sufficient: a curation-scoped token minted for a non-admin user is
// rejected here — the same UnauthorizedError the domain curation services throw,
// and the same the web adminProcedure raises — so the surface is closed before any
// work runs. The role is server-derived from the token (auth.ts → validateAccessToken
// → users.role), never from a tool argument.
function assertAdmin(principal: Principal): void {
  if (principal.role !== "admin") throw new UnauthorizedError();
}

// Attribution stamped onto every curation write: actor `agent` (this surface IS
// the ops agent), plus the batch runId and confidence from the call. Actor is set
// here server-side — never from arguments. Nullish runId/confidence collapse to
// absent so the audit row's columns stay null when not supplied.
function curationAttribution(args: { runId?: string | null; confidence?: number | null }): CurationAttribution {
  return {
    actor: "agent",
    ...(args.runId != null ? { runId: args.runId } : {}),
    ...(args.confidence != null ? { confidence: args.confidence } : {}),
  };
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
    confirmedDistinct: args.confirmedDistinct,
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
    confirmedDistinct: args.confirmedDistinct,
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

// The batch's own envelope plus the provenance every item inherits. The items
// pass through UNSHAPED: their leaves are the record_purchase leaves the domain
// already re-validates, and a reshape here would be a second place for the two
// tools' semantics to drift.
function toRecordPurchaseBatchInput(
  args: RecordPurchaseBatchArgs,
  clientId: string,
  correlationId: string,
): RecordPurchaseBatchInput {
  return {
    clientRequestId: args.clientRequestId,
    defaults: args.defaults,
    items: args.items as unknown as RecordPurchaseBatchInput["items"],
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
        "Resolve a conversational cigar mention to catalog entries by fuzzy (trigram) name match. Use when a cigar is named or asked about, not for the user's own history. Prefer the fullest name the user gave — a bare word or a single product token may not match. Read `guidance`: single_match (an exact catalog-name hit — proceed with it), brand_match (only a brand was named — ask for the line/vitola), multiple_matches (candidates but no exact hit — confirm the exact one with the user before saving), no_match (nothing matched — call add_cigar, then save against the cigarId it returns, in the same turn; a described save_smoke still creates the cigar, but that is the safety net, not the action to take here; if the mention was partial/abbreviated, ask for the fuller name first so you don't create a duplicate).",
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
        "Fetch full catalog detail (blend, vitola, origin) for one resolved cigar id, plus `scores` — the critic and journal aggregates, each with its sample count and the level (cigar or blend) it was computed at. Use after search_cigars when factual specifics help the conversation.",
      inputSchema: getCigarSchema,
      outputSchema: getCigarOutput,
      annotations: { readOnlyHint: true, title: "Get cigar" },
    },
    (args, extra) =>
      run("get_cigar", extra.authInfo, async ({ principal, scopes }) => {
        const personal = scopes.includes(PERSONAL_SCOPE);
        // The journal aggregate's population is scope-bounded like everything
        // else personal here. With journal:read it is the viewer's (public
        // journals plus the caller's own, DESIGN-006 rule 1); without it, the
        // community population alone — a catalog-only token must not read a
        // number the caller's own private ratings moved.
        const result = await getCigar(deps, principal, {
          cigarId: args.cigarId,
          journalPopulation: personal ? "viewer" : "public",
        });
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
          // ADR-013 §3 / DESIGN-006: two labelled aggregates, never mixed, each
          // with its sample count and the level it was computed at. Always
          // present — both members null when nothing has been observed — because
          // "nobody has scored this" is an answer the model needs to be able to
          // give, and an absent key reads as "the tool did not say".
          scores: result.scores,
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
    "browse_catalog",
    {
      title: "Browse catalog",
      description:
        "Page the cigar catalog with composable filters and sorts — the tool for browsing, filtering, and shopping questions (use search_cigars instead to resolve one named cigar). Filters combine in one call: q (name/brand/line text), brand (one brand exactly), type (NC|CC), criticScoreMin (0-100), and independent booleans inHumidor / wanted / smoked / inStock (each true or false, all AND together). Sort by name, my-rating, recently-added, price (cheapest current per-stick first; unpriced cigars last), or critic-score (best reviewed first; unscored cigars last). Returns tiles with a catalog-scoped price-at-a-glance (per-stick with its packaging, or the package price) and critics (the cigar’s own critic score with its observation count, null when unreviewed), plus — under journal:read — the personal overlay (smokeCount, myRating, remaining, wanted, favorited); without journal:read the personal filters and overlay are omitted. Page with the returned nextCursor.",
      inputSchema: browseCatalogSchema,
      outputSchema: browseCatalogOutput,
      annotations: { readOnlyHint: true, title: "Browse catalog" },
    },
    (args, extra) =>
      run("browse_catalog", extra.authInfo, async ({ principal, scopes }) => {
        const personal = scopes.includes(PERSONAL_SCOPE);
        // Personal overlay AND the personal filters are journal:read-bounded:
        // without it, inHumidor/wanted/smoked are dropped (the result set never
        // leaks the user's own state) and the overlay fields are omitted from each
        // tile. Catalog + market data (q/brand/type/inStock/price sort and
        // price-at-a-glance) always apply — the same scope-bounding idiom as
        // search_cigars/get_cigar, extended to the filters that read personal state.
        const result = await browseCatalog(deps, principal, {
          q: args.q,
          brand: args.brand,
          type: args.type,
          sort: args.sort,
          inStock: args.inStock,
          criticScoreMin: args.criticScoreMin,
          ...(personal
            ? { inHumidor: args.inHumidor, wanted: args.wanted, smoked: args.smoked }
            : {}),
          cursor: args.cursor,
          limit: args.limit,
        });
        const cigars = result.cigars.map((t) => ({
          cigarId: t.cigarId,
          canonicalName: t.canonicalName,
          brand: t.brand,
          line: t.line,
          vitola: t.vitola,
          type: t.type,
          verification: t.verification,
          // Price-at-a-glance is catalog/market data — always included (ADR-009);
          // a per-stick figure always carries its packaging (shape-enforced).
          price: t.price,
          // The leaf's own critic aggregate (ADR-013 §3, DESIGN-006) — catalog
          // data like the price, so every caller sees it. Null when unreviewed,
          // and never the blend's number: a tile states no scope.
          critics: t.critics,
          // Personal overlay: present only with journal:read. hasProductPhoto is
          // a web-only tile field and stays excluded to keep the payload stable.
          ...(personal
            ? {
                smokeCount: t.userSmokeCount,
                myRating: t.userRating,
                remaining: t.remaining,
                wanted: t.wanted,
                favorited: t.favorited,
              }
            : {}),
        }));
        return jsonResult({ cigars, nextCursor: result.nextCursor, totalCount: result.totalCount });
      }),
  );

  server.registerTool(
    "get_offers",
    {
      title: "Get offers",
      description:
        "Current market offers for one cigar plus a compact price history — use when the user asks about price or where to buy. Each offer carries the vendor (with isRegistryVendor), price and currency, per-stick figure with its packaging, stock, when it was seen, and a listing link. The history block gives first/last seen, the min/max per-stick observed, and the total observation count. Kept separate from get_cigar to protect that tool's token budget; returns empty offers and a zeroed history when nothing is recorded.",
      inputSchema: getOffersSchema,
      outputSchema: getOffersOutput,
      annotations: { readOnlyHint: true, title: "Get offers" },
    },
    (args, extra) =>
      run("get_offers", extra.authInfo, async () => {
        // Catalog/market-scoped (offers are the same for every viewer), so no
        // personal bounding. Both reads run over the same observation set.
        const [offers, history] = await Promise.all([
          getCigarOffers(deps, { cigarId: args.cigarId }),
          getCigarOfferHistory(deps, { cigarId: args.cigarId }),
        ]);
        return jsonResult({ offers, history });
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
          // The session's bounds and its derived length (ADR-016) — null when
          // the smoke carries no such observation.
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          durationMinutes: s.durationMinutes,
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
        "Persist one finished smoke, called once when the user signals the cigar is over — never per observation. Omit anything the user did not establish; sparse is correct. When you pass a consumption block (the ask-once 'From your humidor?' beat), the result adds holdingAfter { totalAcquired, remaining } so you can confirm the new count without another read. A described cigar can error cigar_ambiguous when the name lands a word away from a catalog sibling — show the user the search_cigars candidates; when they confirm one, save against that cigarId under the same clientRequestId, since the failed save wrote nothing. When they confirm none is theirs, create the distinct product with add_cigar confirmedDistinct:true and save against the cigarId it returns under a FRESH clientRequestId, because add_cigar has spent the first one. This tool has no confirmedDistinct of its own.",
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
            // What the save established about the session (ADR-016) — the bounds
            // and the length derived from them, so the model can tell the user
            // how long the smoke took without a follow-up read. Undefined (and
            // so absent) on a replay of an envelope stored before they existed.
            startedAt: result.smoke.startedAt,
            endedAt: result.smoke.endedAt,
            durationMinutes: result.smoke.durationMinutes,
          },
          cigarCreated: result.cigarCreated,
          // True when this save CREATED the catalog entry and queued its background
          // enrichment (#177) — so it implies cigarCreated, and a save that linked
          // to an existing cigar reports false. Undefined (and so absent) on a
          // replay of an envelope stored before the field existed.
          enrichmentQueued: result.enrichmentQueued,
          // Present only when a consumption block was supplied (ADR-008): the
          // derived stock after the deduction, mirroring record_purchase's
          // holdingAfter. Additive — undefined serializes away when absent.
          holdingAfter: result.holdingAfter,
          // What the `photoDropId` claim did (ADR-014) — present only when the
          // save carried one. Reported, never raised: the smoke is committed
          // before the claim runs, so `not_found`/`bound_elsewhere`/`failed` all
          // arrive as a status on a successful save, and the model reads
          // `attached` to tell the user how many photos landed.
          photoDrop: result.photoDrop,
          replayed: result.replayed,
        });
      }),
  );

  server.registerTool(
    "add_cigar",
    {
      title: "Add cigar",
      description:
        "The user names a cigar missing from the catalog. Confirm the fullest name first (search_cigars guidance applies); the entry is created unverified from their words and a background enrichment request is queued to fill specs and a product photo. Use before save_smoke or record_purchase when nothing matches — and it is a prelude, never the answer: it writes NO journal entry and no purchase (journalEntryCreated is always false), so the save_smoke or record_purchase that motivated it still has to run in the same turn, against the cigarId returned. A catalog row with no journal entry is worse than no row at all, because it looks like success and drops what the user actually said. If it errors cigar_ambiguous or you fear a silent link to a near-match (a number/packaging variant), show the user search_cigars candidates; when they confirm none is theirs, retry with confirmedDistinct:true. `guidance` is 'created' for a new entry or 'already_existed' when the name linked to an existing one.",
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
          // The point-of-use restatement of the gap-fill invariant (#177): this tool
          // catalogs, it does not journal. A constant, and deliberately emitted HERE
          // rather than from the domain result — the domain result is what
          // recordIdempotency persists, so an adapter constant rides identically on a
          // first call and on a replay, and no stored envelope can be missing it.
          journalEntryCreated: false,
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
        "Append an acquisition to the humidor ledger, or correct the count. quantity is a positive integer for a purchase; it may be NEGATIVE to correct an over-count — say why in notes. Record only stated facts (never invent a price, date, or vendor); a described cigar with no catalog match is auto-created and its enrichment queued. If it errors cigar_ambiguous — or you fear a silent link to a near-match (a number or packaging variant) — show the user the search_cigars candidates; when they confirm none is theirs, re-issue this same call with confirmedDistinct:true, which creates the distinct product and lands the purchase in one call rather than a detour through add_cigar. Corrections are rows too — holdings stay derived. Output: purchaseId, cigar, holdingAfter { totalAcquired, remaining }, and wanted — when wanted is true the user just bought something on their want list, so offer to clear it with set_want (never clear it silently).",
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
          // Whether the purchase created the catalog row and queued its
          // enrichment — the pair save_smoke already reports. Undefined (and so
          // absent) on a replay of an envelope stored before they existed.
          cigarCreated: result.cigarCreated,
          enrichmentQueued: result.enrichmentQueued,
          replayed: result.replayed,
        });
      }),
  );

  server.registerTool(
    "record_purchase_batch",
    {
      title: "Record purchase batch",
      description:
        "Log one acquisition of several different cigars — a sampler, a box inventory, a shop run, a retailer order — in a single call. Shared facts go in `defaults` (the one date, vendor and packaging the lot was bought under); each distinct cigar is one `items` entry with its own clientRequestId and quantity, and may override any default. Every item is an ordinary record_purchase: a described cigar with no catalog match is auto-created and its enrichment queued, and each item carries its own confirmedDistinct. Results are PER ITEM — `created` (the ledger row landed and this item created the catalog entry), `existing` (it landed against an entry the catalog already had), `ambiguous` (nothing written; `error.candidates` are the siblings to show the user), `failed` (nothing written; `error` says why) — so one undecidable cigar never fails the batch. To recover: show the user the ambiguous items' candidates and, when they confirm none is theirs, re-send the WHOLE batch under a fresh batch clientRequestId with `confirmedDistinct: true` on just those items and every other item unchanged — items already recorded replay, so nothing is logged twice.",
      inputSchema: recordPurchaseBatchSchema,
      outputSchema: recordPurchaseBatchOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Record purchase batch",
      },
    },
    (args, extra) =>
      run("record_purchase_batch", extra.authInfo, async ({ principal, clientId }, correlationId) => {
        const result = await recordPurchaseBatch(
          deps,
          principal,
          toRecordPurchaseBatchInput(args, clientId, correlationId),
        );
        // The domain result IS the contract payload — items, summary, replayed —
        // so unlike the single tools there is nothing to reshape here. Passing it
        // through whole also keeps a replayed batch byte-identical to its first
        // response, since that response is what the envelope stored.
        return jsonResult(result);
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
    "open_photo_drop",
    {
      title: "Open photo drop",
      // THE PHOTO PATH FOR A LIVE SMOKE (ADR-014, issue #263). add_smoke_photo
      // binds to a smokeId, and a live smoke is one save_smoke at the end, so
      // until this tool every photo taken during a smoke had to be sent twice —
      // once when it was taken, once at the end when there was finally something
      // to attach it to. The description leads with WHEN to call it, because the
      // whole value is in the timing: the moment a photo appears, not when the
      // smoke ends.
      //
      // It says "relay it once" for a reason the model cannot infer: the link is
      // multi-use for its 48 hours, so re-minting per photo would train the user to
      // wait for a new link they do not need.
      description:
        "Open a photo drop for the smoke in progress: a link the user adds photos to at any point during the smoke, before it is saved. Call it the moment a photo appears in the conversation or the user says they took one, and relay the link (shareWithUser is the sentence to say); the same link takes every later photo of this smoke, so relay it once. Keep the photoDropId and pass it to save_smoke, which attaches the dropped photos to the saved smoke; the link then keeps working for that smoke until it expires (48 hours). Opening again while a drop is open returns that drop with a fresh link. If the client forwarded an attached image with the call it is stored into the drop directly (delivery reports which happened). Never fill the image argument yourself — no URLs, ids, or invented fields. delivery.status no_image_received is the normal outcome on every current client — relay the link and do not report it as a problem.",
      inputSchema: openPhotoDropSchema,
      outputSchema: openPhotoDropOutput,
      // The same file-input declaration add_smoke_photo publishes: a host that
      // forwards an attachment gets it stored into the drop.
      _meta: PHOTO_FILE_PARAMS_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Not idempotent: a second open ROTATES the token, which kills the link
        // the first one returned (the raw token is never stored, so reuse must
        // re-mint). Same drop, different link — a client that treats the call as
        // repeatable would hand the user a dead URL.
        idempotentHint: false,
        title: "Open photo drop",
      },
    },
    (args, extra) =>
      run("open_photo_drop", extra.authInfo, async ({ principal }, correlationId) => {
        const intake = await intakePhoto({
          tool: "open_photo_drop",
          image: args.image,
          requestMeta: extra._meta as Record<string, unknown> | undefined,
          storage,
          correlationId,
          sessionId: extra.sessionId,
          rpcId: extra.requestId,
        });

        const drop = await openPhotoDrop(deps, intake.storage, principal, {
          correlationId,
          actor: "mcp",
        });
        const url = dropUrl(drop.token);

        // A forwarded image goes STRAIGHT INTO the drop it just opened, through
        // the same token path the web page uploads on — so one photo cannot arrive
        // by a route the drop's own page does not know about.
        let staged: { photoId: string; kind: string; width: number; height: number } | undefined;
        if (intake.image) {
          const photo = await stagePhotoByToken(deps, intake.storage, {
            token: drop.token,
            image: intake.image,
            correlationId,
          });
          staged = {
            photoId: photo.photoId,
            kind: photo.kind,
            width: photo.width,
            height: photo.height,
          };
        }
        const photoCount = drop.photoCount + (staged ? 1 : 0);

        return jsonResult({
          photoDropId: drop.photoDropId,
          uploadUrl: url,
          expiresAt: drop.expiresAt,
          reused: drop.reused,
          photoCount,
          // The sentence to say, as on add_smoke_photo — a link nobody relays
          // collects nothing. The reused wording names what is already waiting, so
          // a model that lost the id in a long chat can tell the user their photos
          // are still there rather than reopening the subject.
          shareWithUser:
            drop.reused && photoCount > 0
              ? `Send the user this link to add photos during the smoke: ${url} — it already holds ${photoCount} ${photoCount === 1 ? "photo" : "photos"}, every photo of this smoke goes there, and they attach to the review when it is saved. It lasts 48 hours.`
              : `Send the user this link to add photos during the smoke: ${url} — every photo of this smoke goes there, and they attach to the review when it is saved. It lasts 48 hours.`,
          // Exactly one of the two, always: `staged` when a forwarded image landed
          // in the drop, `delivery` (add_smoke_photo's vocabulary) when none did.
          ...(staged ? { staged } : { delivery: intake.delivery }),
        });
      }),
  );

  server.registerTool(
    "add_smoke_photo",
    {
      title: "Add smoke photo",
      // THE LINK IS THE FLOW, and this text now says so first. Earlier drafts led
      // with attachment and described the link as what you get when attachment
      // fails — a framing that outlived its evidence. `photo_intake_request`
      // settled it on 2026-08-31: a live ChatGPT call carried no `openai/fileParams`
      // on any channel (`metaFileParams: {"type":"absent"}`, no `image` argument, no
      // undeclared keys), and `mode: attached` has never once been observed in
      // production. ChatGPT does hydrate fileParams for some servers, so the
      // mechanism is real — it has just never been aimed here (client-
      // compatibility.md, 2026-08-31: host-side gating is the leading explanation).
      // And no other client has the mechanism at all, so the link is the only path
      // that works everywhere. Leading with a mode that has never fired taught the
      // model to treat the working path as a consolation prize.
      //
      // THE SAME-TURN SENTENCE IS GONE (2026-09-01, ADR-014). The retest ran with
      // the image attached to the invoking message and the host still forwarded
      // nothing, so advice that costs the user a re-attach for a path shown not to
      // fire is withdrawn. What replaces it is not advice but a design: this tool
      // now points a live smoke at open_photo_drop, which takes the photo when it
      // is taken instead of asking for it again at the end.
      //
      // Attachment stays declared and stays implemented — it costs nothing to keep
      // and it is how this works the day a host forwards a file — but it is now
      // described as the opportunistic branch it is. `delivery.status` keeps its own
      // vocabulary (below): it earns its place by telling the model the truth about
      // what arrived, which is exactly what the probe was built to learn.
      description:
        "Add a photo to a smoke that is already saved. Returns a one-time upload link — share it with the user; it works once and lasts 24 hours. With photoDropId it instead attaches the photos of that drop to the smoke (for a drop save_smoke did not carry) and mints no link. If the client forwarded an attached image with the call, the photo is stored directly and no link is needed (delivery reports which happened). For a photo taken during a smoke that is not saved yet, use open_photo_drop. Never fill the image argument yourself — no URLs, ids, or invented fields. delivery.status no_image_received is the normal outcome on every current client — relay the upload link and do not report it as a problem.",
      inputSchema: addSmokePhotoSchema,
      outputSchema: addSmokePhotoOutput,
      // Declare `image` as a file input so ChatGPT forwards the attached photo.
      _meta: PHOTO_FILE_PARAMS_META,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        title: "Add smoke photo",
      },
    },
    (args, extra) =>
      run("add_smoke_photo", extra.authInfo, async ({ principal }, correlationId) => {
        // MODE C — a drop the save did not carry (ADR-014). It takes no intake and
        // mints no link: the photos already exist, staged against the drop, and
        // the whole call is the claim that moves them onto this smoke. It runs
        // ahead of the storage check because it touches no bucket at all.
        //
        // The two "wrong id" answers differ from the SAVE's, and must: there the
        // smoke is already committed so a bad drop is reported rather than raised
        // (ADR-007), while here the claim IS the call and has no result to carry a
        // status on. A drop that is not the caller's is `photo_drop_not_found`
        // (never distinguished from one that never existed), and one already bound
        // to a different smoke is a validation_error naming the field — the photos
        // belong to that other smoke and moving them would take them off it.
        if (args.photoDropId !== undefined) {
          const photoDrop = await claimPhotoDrop(deps, principal, {
            photoDropId: args.photoDropId,
            smokeId: args.smokeId,
            correlationId,
            actor: "mcp",
          });
          if (photoDrop.status === "not_found") throw new PhotoDropNotFoundError();
          if (photoDrop.status === "bound_elsewhere") {
            throw new ValidationError([
              { path: "photoDropId", message: "Already attached to another smoke." },
            ]);
          }
          return jsonResult({ mode: "drop_claimed", photoDrop });
        }

        const intake = await intakePhoto({
          tool: "add_smoke_photo",
          image: args.image,
          requestMeta: extra._meta as Record<string, unknown> | undefined,
          storage,
          correlationId,
          sessionId: extra.sessionId,
          rpcId: extra.requestId,
        });

        // Mode A — opportunistic: a host forwarded a file and it decoded.
        if (intake.image) {
          const photo = await addSmokePhoto(deps, intake.storage, principal, {
            smokeId: args.smokeId,
            kind: args.kind,
            caption: args.caption ?? null,
            image: intake.image,
            actor: "mcp",
            correlationId,
          });
          return jsonResult({ mode: "attached", photo });
        }

        // Mode B — the ordinary path: mint a single-use link bound to
        // (user, smoke, kind?, caption?) for the user to open on their phone, and
        // tell the model plainly why it got one.
        const minted = await mintPhotoUploadToken(deps, principal, {
          smokeId: args.smokeId,
          kind: args.kind,
          caption: args.caption ?? null,
          correlationId,
        });
        const url = uploadUrl(minted.token);
        return jsonResult({
          mode: "upload_url",
          uploadUrl: url,
          expiresAt: minted.expiresAt,
          // The sentence to say, not a fact to interpret. A bare `uploadUrl`
          // field left the model to decide whether a link was worth mentioning;
          // this is the whole point of the call, so the result says so in words.
          shareWithUser: `Send the user this link to add their photo: ${url} — it works once and is valid for 24 hours.`,
          delivery: intake.delivery,
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

  // ---- curation surface (admin only; DESIGN-003 wave 4a, issue #126) --------
  // The ops-agent tools. Each requires its curation scope (assertToolScope) AND an
  // admin principal (assertAdmin) — a curation-scoped non-admin token is rejected.
  // Every write threads the run's attribution and stamps audit actor `agent`.

  server.registerTool(
    "get_curation_queue",
    {
      title: "Get curation queue",
      description:
        "Page the catalog curation backlog by kind: unverified (active cigars not yet verified), duplicates (near-duplicate name pairs — human merge only, no tool here), match_triage (vendor listings the crawler has not settled — `status` auto is a proposed link, carrying the matched cigar's facts so a confirm/unmatch is judgeable in one read; `status` unmatched is a listing it produced no link for, with `reason` market_refusal when it found a candidate and declined it because the vendor's market contradicts the cigar's, no_match when nothing matched, no_anchor when the title named no brand the registry knows — a registry gap, closed with update_registry_aliases, not by loosening the matcher — or ambiguous when a brand anchored but no single catalog entry under it settled: several fit, or the listing is an assortment naming none (the parse says which). Neither no_anchor nor ambiguous is a matcher fault: an ambiguous row whose candidates are one entry standing for several products is split_cigar's case, an assortment is nobody's and is reported), unbranded (no brand linked), unlined (on a brand, no line), unblended (on a line, no blend), untyped (null NC/CC), missing_photos (no product photo). The three structural kinds are one ladder worked in order — register_taxonomy mints what is missing, assign_cigar_taxonomy attaches it, and a row leaving unbranded appears in unlined. Every cigar row carries brandId/lineId/blendId, which is what those verbs take. Drain a kind with the returned nextCursor. Admin only.",
      inputSchema: getCurationQueueSchema,
      outputSchema: getCurationQueueOutput,
      annotations: { readOnlyHint: true, title: "Get curation queue" },
    },
    (args, extra) =>
      run("get_curation_queue", extra.authInfo, async ({ principal }) => {
        assertAdmin(principal);
        const result = await curationWorklist(deps, principal, {
          kind: args.kind,
          cursor: args.cursor,
          limit: args.limit,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "set_listing_match_status",
    {
      title: "Set listing match status",
      description:
        "Rule on a vendor listing→cigar auto-match from get_curation_queue match_triage: confirmed keeps the matched cigar, unmatched clears the link (the listing matched no catalog cigar). Applies to a `status` auto row only — an unmatched row points at no cigar, so there is nothing to confirm and it is already unmatched; report it instead. When unmatching, pass unmatchedReason: a stated reason is a verdict later enrichment preserves, while an unmatch with none may be superseded when the catalog grows. Admin only. Pass runId/confidence for the run audit.",
      inputSchema: setListingMatchStatusSchema,
      outputSchema: setListingMatchStatusOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Set listing match status" },
    },
    (args, extra) =>
      run("set_listing_match_status", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await setListingMatchStatus(deps, principal, {
          clientRequestId: args.clientRequestId,
          matchId: args.matchId,
          status: args.status,
          ...(args.unmatchedReason === undefined ? {} : { unmatchedReason: args.unmatchedReason }),
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "set_cigar_facts",
    {
      title: "Set cigar facts",
      description:
        "Curator write of a cigar's identity facts (brand, line, type, manufacturer). Unlike update_cigar this OVERWRITES a wrong value and may touch a verified row — the curator's authority. A field present is written (a value sets it, null clears a wrong one); an omitted field is untouched. Never guess brand or type — leave an uncertain field out. Admin only. Pass runId/confidence for the run audit.",
      inputSchema: setCigarFactsSchema,
      outputSchema: setCigarFactsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Set cigar facts" },
    },
    (args, extra) =>
      run("set_cigar_facts", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await setCigarFacts(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          fields: args.fields,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "verify_cigar",
    {
      title: "Verify cigar",
      description:
        "Mark an unverified catalog cigar as verified (curator-trusted). Admin only. Idempotent; pass runId/confidence for the run audit.",
      inputSchema: verifyCigarSchema,
      outputSchema: verifyCigarOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Verify cigar" },
    },
    (args, extra) =>
      run("verify_cigar", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await verifyCigar(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "exclude_cigar",
    {
      title: "Exclude cigar",
      description:
        "Hide a catalog cigar from browse/search/queue without deleting it (non-cigar pollution, or an entry that should not surface) — reversible via restore_cigar; its detail page and any owner history stay reachable. Refused for a cigar anybody holds (any purchase lot, any user — get_curation_queue reports heldLots): hiding it would hide their inventory, so rename or merge it instead. Admin only. Pass runId/confidence for the run audit.",
      inputSchema: excludeCigarSchema,
      outputSchema: setCatalogStatusOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Exclude cigar" },
    },
    (args, extra) =>
      run("exclude_cigar", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await excludeCigar(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "restore_cigar",
    {
      title: "Restore cigar",
      description:
        "Restore an excluded catalog cigar to active — the undo of exclude_cigar (the audit self-links the exclude it reverses). Admin only. Pass runId/confidence for the run audit.",
      inputSchema: restoreCigarSchema,
      outputSchema: setCatalogStatusOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Restore cigar" },
    },
    (args, extra) =>
      run("restore_cigar", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await restoreCigar(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "set_product_photo_rights",
    {
      title: "Set product photo rights",
      description:
        "Set a catalog cigar's product-photo rights: approved clears it for display, suppressed is a takedown (stops serving it and drops it from every cover read), pending is the crawl default. Use suppressed for an obvious mismatch or a rights problem. Admin only. Pass runId/confidence for the run audit.",
      inputSchema: setProductPhotoRightsSchema,
      outputSchema: setProductPhotoRightsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Set product photo rights" },
    },
    (args, extra) =>
      run("set_product_photo_rights", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await setProductPhotoRights(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          rights: args.rights,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "rename_cigar",
    {
      title: "Rename cigar",
      description:
        "Set a catalog cigar's canonical name (identity) — the one authorized path, since update_cigar and set_cigar_facts never touch the name. Use to fix a wrong or malformed canonical name; the value is trimmed and must be non-empty. Admin only. Idempotent (a no-op when the name already matches); pass runId/confidence for the run audit.",
      inputSchema: renameCigarSchema,
      outputSchema: renameCigarOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Rename cigar" },
    },
    (args, extra) =>
      run("rename_cigar", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await renameCigar(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          canonicalName: args.canonicalName,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "queue_enrichment_backlog",
    {
      title: "Queue enrichment backlog",
      description:
        "Operator-initiated bulk enqueue: turn the caller's photoless holdings — the cigars they hold with no servable product photo — into enrichment requests for the crawler, instead of looping request_cigar_enrichment. Do not call this on your own initiative; report the worklist and leave the press to the operator. It queues a row ONLY when the cigar's canonical name is verified and some crawl-enabled vendor covering its market has completed an enrich run; every other row is reported with the reason and nothing is written for it (unverified_name, no_vendor_coverage, already_queued, recently_enriched, not_needed, exhausted, vendor_unreachable). A retired row names the vendors that looked in `triedVendors`; an `already_queued` row names the lanes that still owe it a look in `awaitingVendors`, and its absence there means no lane counts against the row at all. A queued request that cannot be matched is not free — the crawler retires it after two completed looks per vendor. Selects highest remaining stock first, capped by limit. Admin only. Idempotent via clientRequestId; pass runId/confidence for the run audit.",
      inputSchema: queueEnrichmentBacklogSchema,
      outputSchema: queueEnrichmentBacklogOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Queue enrichment backlog",
      },
    },
    (args, extra) =>
      run("queue_enrichment_backlog", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await queueEnrichmentBacklog(deps, principal, {
          clientRequestId: args.clientRequestId,
          limit: args.limit ?? undefined,
          retryExhausted: args.retryExhausted ?? undefined,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  // The taxonomy verbs (ADR-012 Wave 3, issue #196). Same gate, same envelope,
  // same server-side `actor: agent` stamp as the rest of the curation surface.

  server.registerTool(
    "register_taxonomy",
    {
      title: "Register taxonomy",
      description:
        "Find or mint the registry path a catalog entry needs: a brand, the line under it, the blend under that. Finding and minting are the same call — `created` on each level says which happened — so structuring a brand's fiftieth row costs no more than its first. Name the marca exactly once: `brandId` when a queue row already carries one, or `brand` to resolve it by name and mint it only if it is genuinely new. A blend requires its line. `aliases` are other SPELLINGS the level answers to (Padron, RYJ); they become matching keys server-side, so pass the spelling, never a slug. A key another entity at the same level already claims is refused and the holder is named — that refusal is a near-duplicate caught, so use the entity it names rather than working around it. `blend.blenders` credits people by name and mints them as needed; Cuban blends credit no individual, so omit it rather than guess. Never invent a level: an entry whose line is unknown belongs to its brand and stops there. Admin only. Idempotent via clientRequestId; pass runId/confidence for the run audit.",
      inputSchema: registerTaxonomySchema,
      outputSchema: registerTaxonomyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Register taxonomy" },
    },
    (args, extra) =>
      run("register_taxonomy", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await registerTaxonomy(deps, principal, {
          clientRequestId: args.clientRequestId,
          ...(args.brandId != null ? { brandId: args.brandId } : {}),
          ...(args.brand != null ? { brand: args.brand } : {}),
          ...(args.line != null ? { line: args.line } : {}),
          ...(args.blend != null ? { blend: args.blend } : {}),
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "update_registry_aliases",
    {
      title: "Update registry aliases",
      description:
        "Add or drop the spellings a brand, line, blend or blender answers to. This is what closes a match_triage row reported no_anchor: the vendor's title named the marca in a spelling the registry does not know, and the fix is a key here — never a looser matcher. Pass display spellings (Padrón, RYJ, H. Upmann); they are folded to matching keys server-side, so case and accents do not matter on either list. `add` is refused when another entity at the same level already claims the key, naming the holder. `remove` is refused for a key derived from the entity's own name — rename it instead — and refused if it would leave the entity with no keys at all; either would make it unreachable. Adding a key it already has, or removing one it lacks, is a no-op: `added` and `removed` report what actually moved. Admin only. Idempotent via clientRequestId; pass runId/confidence for the run audit.",
      inputSchema: updateRegistryAliasesSchema,
      outputSchema: updateRegistryAliasesOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Update registry aliases",
      },
    },
    (args, extra) =>
      run("update_registry_aliases", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await updateRegistryAliases(deps, principal, {
          clientRequestId: args.clientRequestId,
          level: args.level,
          id: args.id,
          ...(args.add != null ? { add: args.add } : {}),
          ...(args.remove != null ? { remove: args.remove } : {}),
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "rename_registry_entity",
    {
      title: "Rename registry entity",
      description:
        "Correct the spelling a brand, line, blend or blender is DISPLAYED under — `H Upmann` to `H. Upmann`, `Partagas` to `Partagás`. Reach for it when a registry entry is right but its spelling is not; it is the act `update_registry_aliases` names when it refuses to drop an entity's own key. Nothing but the name moves: the entity keeps its slug, so published links still resolve, and it keeps every matching key it already holds, so vendor listings that match today keep matching. The new spelling is added as a key only when it folds to one the entity does not already answer to — and that key is refused, naming the holder, when another entity at the same level claims it, which is a near-duplicate caught. Catalog entries whose name is composed from their parts are recomposed to the new spelling in the same call; `recomposedCigars` says how many moved. Renaming an entity to the name it already carries writes nothing and reports `changed: false`. Admin only. Idempotent via clientRequestId; pass runId/confidence for the run audit.",
      inputSchema: renameRegistryEntitySchema,
      outputSchema: renameRegistryEntityOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Rename registry entity",
      },
    },
    (args, extra) =>
      run("rename_registry_entity", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await renameRegistryEntity(deps, principal, {
          clientRequestId: args.clientRequestId,
          level: args.level,
          id: args.id,
          name: args.name,
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "assign_cigar_taxonomy",
    {
      title: "Assign cigar taxonomy",
      description:
        "Place a catalog entry in the taxonomy — brand, line, blend — and set its vitola and edition. A field present is written (null clears it); an omitted field is untouched. Set the marca by `brand` (the spelling, from which brandId is re-derived) or by `brandId`, never both. The levels must agree: a line belongs to the brand and a blend to the line, and an inconsistent set is refused naming the level at fault. Never invent a level — leave an unknown one out, and an entry whose line is unknown hangs off its brand. `nameSource` composed hands the canonical name over to the parts, recomposing it now and on every later part change; freeform keeps the stored string and leaves the name to rename_cigar. Send `preview: true` first to see `composedName` and the fields that would change while writing nothing — the same validation runs, so a refusal shows up on the preview too, and the same clientRequestId then commits it. Admin only. Idempotent via clientRequestId; pass runId/confidence for the run audit.",
      inputSchema: assignCigarTaxonomySchema,
      outputSchema: assignCigarTaxonomyOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        title: "Assign cigar taxonomy",
      },
    },
    (args, extra) =>
      run("assign_cigar_taxonomy", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await assignCigarTaxonomy(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          ...(args.brand === undefined ? {} : { brand: args.brand }),
          ...(args.brandId === undefined ? {} : { brandId: args.brandId }),
          ...(args.lineId === undefined ? {} : { lineId: args.lineId }),
          ...(args.blendId === undefined ? {} : { blendId: args.blendId }),
          ...(args.vitolaName === undefined ? {} : { vitolaName: args.vitolaName }),
          ...(args.edition === undefined ? {} : { edition: args.edition }),
          ...(args.nameSource === undefined ? {} : { nameSource: args.nameSource }),
          ...(args.preview === undefined ? {} : { preview: args.preview }),
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  server.registerTool(
    "split_cigar",
    {
      title: "Split cigar",
      description:
        "Split a catalog entry that has been standing for several products into the leaves it should have been, moving each product's vendor listings onto its own. Reach for it on a match_triage row reported ambiguous, or on an entry whose listings name blends or vitolas it does not distinguish. Each entry in `splits` takes some of this cigar's listings and either an existing sibling (`targetCigarId`) or the parts for a new leaf minted under the same brand, never both — a new leaf needs a line, blend, vitola or edition of its own, or it would be the same product under a second id. A minted leaf inherits the line and blend you omit from the entry being split, so splitting by vitola keeps the structure the entry already had; send an explicit null to say this one has no line. Minting is get-or-create: an arm whose parts already name a live entry re-points onto it and reports `created: false`, and two arms naming the same product collapse onto one leaf. `targetCigarId` must be under the same marca — the destination is a sibling, not any cigar. Split only on unambiguous listing evidence: listings you do not name stay where they are, and a partial split is the expected outcome, not a failure. Every listing named must currently point at this entry and must still be the crawler's own guess — one a curator or agent already ruled on is refused, naming who decided it. All of it applies or none does. Each re-point is individually reversible from the review console, and a leaf minted in error is merged back into the entry it came from. Admin only. Idempotent via clientRequestId; pass runId/confidence for the run audit.",
      inputSchema: splitCigarSchema,
      outputSchema: splitCigarOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Split cigar" },
    },
    (args, extra) =>
      run("split_cigar", extra.authInfo, async ({ principal }, correlationId) => {
        assertAdmin(principal);
        const result = await splitCigar(deps, principal, {
          clientRequestId: args.clientRequestId,
          cigarId: args.cigarId,
          splits: args.splits.map((split) => ({
            listingIds: split.listingIds,
            ...(split.targetCigarId != null ? { targetCigarId: split.targetCigarId } : {}),
            ...(split.lineId === undefined ? {} : { lineId: split.lineId }),
            ...(split.blendId === undefined ? {} : { blendId: split.blendId }),
            ...(split.vitolaName === undefined ? {} : { vitolaName: split.vitolaName }),
            ...(split.edition === undefined ? {} : { edition: split.edition }),
            ...(split.canonicalName === undefined ? {} : { canonicalName: split.canonicalName }),
          })),
          attribution: curationAttribution(args),
          correlationId,
        });
        return jsonResult(result);
      }),
  );

  return server;
}

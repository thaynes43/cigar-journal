// Photo intake for add_smoke_photo (ADR-007): describe what the host delivered,
// and decide what — if anything — can be turned into image bytes.
//
// WHY THIS MODULE EXISTS. Until now the adapter collapsed *every* unusable
// delivery to `null` and silently minted a mode-B upload link. "ChatGPT sent no
// image" and "ChatGPT sent a file handle carrying no fetchable URL" produced
// byte-identical results and byte-identical logs, so a failed attachment was
// undiagnosable from outside: the only record of the owner's 2026-08-30 failure
// was `tool_called {tool, correlationId, latencyMs:9}`. Everything here is pure
// and synchronous — no HTTP, no I/O — so the classification is unit-testable and
// the handler is left with one decision: fetch, decode, or fall back.
//
// THE SHAPE-NOT-VALUES CONTRACT. A `download_url` is a short-lived signed
// credential: its path and query ARE the credential, so no value from a file
// handle is ever logged. The record is deliberately reduced to key NAMES, the
// JSON type of the value, and a per-key "is this a non-empty string" boolean.
// That is enough to answer "what did the host actually send" without putting a
// bearer-equivalent URL, a file id, or image bytes into Loki. The single
// deliberate exception lives in the handler, not here: `fetch.host` (hostname
// only) is logged because it is the only way to tell an egress block from a 403,
// and a hostname is not the credential.

// The internal marker `schemas.ts` wraps an unparsable `image` argument in, so
// this module can classify and LOG its shape instead of the MCP SDK rejecting
// the whole call with InvalidParams before any server-side record exists (a
// class of failure today's logging cannot see at all). Never published in the
// manifest, never forwarded to a fetch, a log value, or a tool result. The name
// is deliberately improbable so a genuine host key can never be misread as it.
export const UNPARSED_IMAGE = "__cj_unparsed_image";

// Shared with the handler's fetch cap: an inline payload is subject to the same
// 20MB ceiling as a fetched one, enforced here BEFORE any base64 decode so an
// oversized string can never be materialized.
export const MAX_ATTACHED_BYTES = 20 * 1024 * 1024;

// URL keys accepted on a file handle, in preference order. `download_url` is the
// OpenAI Apps SDK name and stays first; the rest cover naming drift across hosts
// and the in-progress MCP file-upload drafts (SEP-2356/1306 use `uri`). Accepting
// alternates is free recovery — but it widens what the server will fetch, which
// is why the scheme guard below ships in the same change, not after.
const URL_KEYS = ["download_url", "url", "uri", "href", "file_url"] as const;

// Keys that may carry the image inline as base64 (the SEP-1306 shape). Supporting
// them now means a host that switches to inline delivery just works.
const INLINE_KEYS = ["data", "blob"] as const;

// Content-type keys, covering snake/camel drift between hosts.
const MIME_KEYS = ["mime_type", "mimeType"] as const;

// Log-record caps. Key names are safe for credentials, but a hostile host could
// key a handle by an identifier (`{"file-abc123": …}`), so the record can never
// grow without bound: at most 20 keys, each at most 64 characters.
const MAX_LOGGED_KEYS = 20;
const MAX_KEY_LENGTH = 64;

const OCTET_STREAM = "application/octet-stream";

export type ValueType = "absent" | "null" | "boolean" | "number" | "string" | "array" | "object";

// What a delivery LOOKED like, with no value in it. `filled` lists the subset of
// `keys` whose value is a non-empty string — enough to distinguish "a `file_id`
// key exists" from "a `file_id` key exists and actually carries something".
export interface Shape {
  type: ValueType;
  keys: string[];
  filled: string[];
}

// The request-`_meta` channel additionally reports how many file-param entries
// arrived, so "the host sent nothing" is distinguishable from "the host sent two
// entries and neither was usable".
export interface MetaShape extends Shape {
  count: number;
}

export type Channel = "argument" | "request_meta" | "none";

export type UnusableReason =
  | "not_an_object"
  | "no_url"
  | "empty_url"
  | "bad_scheme"
  | "inline_too_large";

export type Delivery =
  | { kind: "fetchable"; channel: Channel; urlKey: string; url: string; scheme: string; host: string; mimeType?: string }
  | { kind: "inline"; channel: Channel; bytes: Buffer; mimeType?: string }
  | { kind: "unusable"; channel: Channel; reason: UnusableReason }
  | { kind: "absent" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Unwrap the schema's leniency marker. Everything downstream — classification AND
// shape description — works on the RAW delivery, so the log reports the keys the
// host actually sent rather than the wrapper we added around them.
function unwrapImage(value: unknown): unknown {
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, UNPARSED_IMAGE)) {
    return value[UNPARSED_IMAGE];
  }
  return value;
}

function truncateKey(key: string): string {
  return key.length <= MAX_KEY_LENGTH ? key : key.slice(0, MAX_KEY_LENGTH);
}

function valueType(value: unknown): ValueType {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
    case "bigint":
      return "number";
    case "string":
      return "string";
    default:
      // JSON-RPC input cannot produce functions/symbols; anything else is an object.
      return "object";
  }
}

// Describe a value for the log: its JSON type, its (sorted, capped, truncated)
// key names, and which of those keys hold a non-empty string. NO value is copied.
export function shapeOf(value: unknown): Shape {
  const type = valueType(value);
  if (type !== "object") return { type, keys: [], filled: [] };

  const record = value as Record<string, unknown>;
  // Sorted so two records of the same handle compare equal in a Loki query, and
  // so a hostile key order cannot push the interesting key past the cap.
  const names = Object.keys(record).sort();
  const filled = names.filter((key) => {
    const v = record[key];
    return typeof v === "string" && v.length > 0;
  });
  return {
    type,
    keys: names.slice(0, MAX_LOGGED_KEYS).map(truncateKey),
    filled: filled.slice(0, MAX_LOGGED_KEYS).map(truncateKey),
  };
}

// The `image` ARGUMENT as the host sent it (marker unwrapped).
export function describeArgument(image: unknown): Shape {
  return shapeOf(unwrapImage(image));
}

interface MetaSelection {
  present: boolean;
  count: number;
  entry: unknown;
}

// Pick the entry from request-level `_meta["openai/fileParams"]` that
// classification will use: the first USABLE one, falling back to the first
// present one so an all-unusable delivery is still described rather than
// reported as absent. Accepts an array or a single object (both are seen in the
// wild). An empty array is genuinely "no files" — reported as absent.
function selectMetaEntry(meta: unknown): MetaSelection {
  if (!isRecord(meta)) return { present: false, count: 0, entry: undefined };
  const raw = meta["openai/fileParams"];
  if (raw === undefined || raw === null) return { present: false, count: 0, entry: undefined };
  const entries = Array.isArray(raw) ? raw : [raw];
  if (entries.length === 0) return { present: false, count: 0, entry: undefined };
  const usable = entries.find((entry) => classifyHandle(entry, "request_meta").kind !== "unusable");
  return { present: true, count: entries.length, entry: usable ?? entries[0] };
}

// The request-`_meta` channel for the log: the shape of the entry classification
// looked at, plus how many entries arrived.
export function describeRequestMeta(meta: unknown): MetaShape {
  const selection = selectMetaEntry(meta);
  return { ...shapeOf(selection.entry), count: selection.count };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

// Scheme guard. `image.download_url` is a MODEL-WRITABLE argument that the server
// fetches from inside the cluster, so without this the model can point the server
// at anything reachable on the pod network. https is the only real-world delivery;
// http is allowed ONLY on loopback so the test fixtures (a local HTTP server
// standing in for a signed URL) keep working. Everything else — file:, gopher:,
// http to an RFC1918 address — is refused before a socket is opened.
export function fetchTargetOf(raw: string): { scheme: string; host: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // An unparsable reference is refused on the same grounds and reported under
    // the same reason: whatever it is, the server will not open it.
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol === "https:") return { scheme: "https", host };
  const loopback = host === "localhost" || host === "::1" || host.startsWith("127.");
  if (parsed.protocol === "http:" && loopback) return { scheme: "http", host };
  return null;
}

// A base64 payload's decoded size, computed from the ENCODED length so an
// oversized string is rejected without ever being materialized in memory.
function decodedSize(encoded: string): number {
  const clean = encoded.replace(/[\r\n]/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

// Only treat a string as inline image data when it plausibly IS base64 — a short
// or non-base64 value is far more likely to be a caption or an id, and decoding
// it would turn a clean `no_url` diagnosis into a misleading `unreadable` one.
function looksBase64(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9+/_=\s-]+$/.test(value);
}

// `data:[<mediatype>][;base64],<payload>` — decodes directly, so no fetch and no
// SSRF surface. Accepted at any URL key because a host that inlines the image is
// answering the same question a download_url would.
function inlineFromDataUrl(url: string, channel: Channel, declared?: string): Delivery {
  const comma = url.indexOf(",");
  if (comma < 0) return { kind: "unusable", channel, reason: "empty_url" };
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (payload.length === 0) return { kind: "unusable", channel, reason: "empty_url" };

  const parts = header.split(";");
  const base64 = parts
    .slice(1)
    .some((param) => param.trim().toLowerCase() === "base64");
  const mediaType = parts[0]?.trim();
  const mimeType = declared ?? (mediaType && mediaType.length > 0 ? mediaType : undefined);

  if (!base64) {
    // Percent-encoded (non-base64) data URLs are legal but never used for images;
    // decode them anyway rather than lying about what arrived. A malformed escape
    // makes decodeURIComponent throw, and nothing in this module may throw — the
    // caller's contract is that every bad shape comes back as a named reason.
    let decoded: Buffer;
    try {
      decoded = Buffer.from(decodeURIComponent(payload), "binary");
    } catch {
      return { kind: "unusable", channel, reason: "empty_url" };
    }
    if (decoded.byteLength === 0) return { kind: "unusable", channel, reason: "empty_url" };
    if (decoded.byteLength > MAX_ATTACHED_BYTES)
      return { kind: "unusable", channel, reason: "inline_too_large" };
    return { kind: "inline", channel, bytes: decoded, mimeType };
  }

  if (decodedSize(payload) > MAX_ATTACHED_BYTES)
    return { kind: "unusable", channel, reason: "inline_too_large" };
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength === 0) return { kind: "unusable", channel, reason: "empty_url" };
  return { kind: "inline", channel, bytes, mimeType };
}

// Base64 bytes carried in `data`/`blob` next to the handle (the SEP-1306 shape).
// A missing mime_type is fine — the handler sniffs magic bytes before decoding.
function inlineFromFields(
  entry: Record<string, unknown>,
  channel: Channel,
  declared?: string,
): Delivery | null {
  for (const key of INLINE_KEYS) {
    const value = entry[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const raw = value.trim();
    if (raw.toLowerCase().startsWith("data:")) return inlineFromDataUrl(raw, channel, declared);
    if (!looksBase64(raw)) continue;
    if (decodedSize(raw) > MAX_ATTACHED_BYTES)
      return { kind: "unusable", channel, reason: "inline_too_large" };
    const bytes = Buffer.from(raw, "base64");
    if (bytes.byteLength === 0) continue;
    return { kind: "inline", channel, bytes, mimeType: declared };
  }
  return null;
}

// Classify ONE file handle. Never throws, never returns null: an unusable shape
// is a first-class result carrying WHY, which is the whole point of this module.
function classifyHandle(rawEntry: unknown, channel: Channel): Delivery {
  const entry = unwrapImage(rawEntry);
  if (!isRecord(entry)) return { kind: "unusable", channel, reason: "not_an_object" };

  const mimeType = firstString(entry, MIME_KEYS);

  // First non-empty string across the accepted URL keys, in preference order.
  // `sawEmptyUrl` remembers that a URL key existed but was blank, so an empty
  // string is reported as `empty_url` rather than the misleading `no_url`.
  let urlKey: string | undefined;
  let url: string | undefined;
  let sawEmptyUrl = false;
  for (const key of URL_KEYS) {
    const value = entry[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      sawEmptyUrl = true;
      continue;
    }
    urlKey = key;
    url = trimmed;
    break;
  }

  if (url !== undefined && urlKey !== undefined) {
    if (url.toLowerCase().startsWith("data:")) return inlineFromDataUrl(url, channel, mimeType);
    const target = fetchTargetOf(url);
    if (!target) return { kind: "unusable", channel, reason: "bad_scheme" };
    return { kind: "fetchable", channel, urlKey, url, scheme: target.scheme, host: target.host, mimeType };
  }

  const inline = inlineFromFields(entry, channel, mimeType);
  if (inline) return inline;

  // The owner's reported failure lands here: a handle arrived (`file_id`,
  // `mime_type`) with nothing the server can fetch. The file lives in the user's
  // ChatGPT workspace and only the HOST can resolve it into a download_url — this
  // service holds no OpenAI credential and there is no documented endpoint that
  // turns a conversation file id into bytes for a third-party MCP server. So
  // `no_url` is a NAMED, permanent outcome, not a bug to retry.
  if (sawEmptyUrl) return { kind: "unusable", channel, reason: "empty_url" };
  return { kind: "unusable", channel, reason: "no_url" };
}

// Decide what arrived across BOTH accepted channels.
//
// Precedence is unchanged — request `_meta` first, then the declared `image`
// argument — but with one fix: the old `firstFileParam(meta) ?? fileFromArgument(args.image)`
// only fell through when `_meta` was absent OR unusable *because both collapsed
// to null*, and it could never report which channel had the problem. Here a
// present-but-unusable `_meta` still yields to a usable argument, and when
// nothing is usable the ARGUMENT's reason is reported in preference: it is the
// declared Apps SDK path and therefore the one an operator is debugging.
export function classify(argImage: unknown, requestMeta: unknown): Delivery {
  const selection = selectMetaEntry(requestMeta);
  const metaDelivery = selection.present ? classifyHandle(selection.entry, "request_meta") : null;
  const argDelivery =
    unwrapImage(argImage) === undefined ? null : classifyHandle(argImage, "argument");

  if (metaDelivery && metaDelivery.kind !== "unusable") return metaDelivery;
  if (argDelivery && argDelivery.kind !== "unusable") return argDelivery;
  if (argDelivery) return argDelivery;
  if (metaDelivery) return metaDelivery;
  return { kind: "absent" };
}

// Magic-byte sniff for the types the shared pipeline accepts. Hosts hand us
// `application/octet-stream` (or nothing) for perfectly good photos, and the
// pipeline gates on the DECLARED type — so before this a correct image failed on
// a bad header alone.
export function sniffImageType(bytes: Buffer): string | undefined {
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes.toString("latin1", 1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.byteLength >= 12 &&
    bytes.toString("latin1", 0, 4) === "RIFF" &&
    bytes.toString("latin1", 8, 12) === "WEBP"
  )
    return "image/webp";
  // ISO-BMFF: `ftyp` at offset 4, HEIC/HEIF brand at offset 8.
  if (bytes.byteLength >= 12 && bytes.toString("latin1", 4, 8) === "ftyp") {
    const brand = bytes.toString("latin1", 8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"].includes(brand))
      return "image/heic";
  }
  return undefined;
}

// The content type to hand the pipeline. Magic bytes WIN over a declared header:
// a sniff only succeeds on a type the pipeline already accepts, so trusting it
// can only turn a spurious failure into a success. A failed sniff leaves the
// declared value untouched, so a genuinely unsupported body still lands as
// `unreadable` rather than being forced through as an image.
export function resolveContentType(
  declared: string | undefined,
  bytes: Buffer,
): { contentType: string; declaredType: string; sniffedType?: string } {
  const declaredType = declared && declared.trim().length > 0 ? declared.trim() : OCTET_STREAM;
  const sniffedType = sniffImageType(bytes);
  return { contentType: sniffedType ?? declaredType, declaredType, sniffedType };
}

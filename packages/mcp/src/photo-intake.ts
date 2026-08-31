import { isIP } from "node:net";

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
// bearer-equivalent URL, a file id, or image bytes into Loki. There are exactly
// TWO deliberate exceptions, both bounded, both documented in
// security-and-observability.md: `fetch.host` (hostname only — the only way to
// tell an egress block from a 403, and a hostname is not the credential) and
// `declaredType` (the handle's `mime_type` or the response's content-type,
// truncated to MAX_MIME_LENGTH here so a model-writable string cannot grow a log
// line without bound — without it `sniffedType` has nothing to be compared to).

// WHAT THIS MODULE NO LONGER DOES (2026-08-31, issue #202 experiment 1).
// `schemas.ts` used to wrap an `image` argument its schema rejected in an internal
// marker key, so this module could classify and log the shape instead of the SDK
// refusing the call with InvalidParams before any server-side record existed. The
// published `image` schema is strict now, and the marker retired with it: the
// raw-body probe `logPhotoIntakeRequest` (app.ts) already describes a rejected
// delivery from the unparsed JSON-RPC body, before SDK validation, so nothing is
// unobserved. Everything below therefore works on the delivery exactly as the host
// sent it, with no unwrapping step.

// The handler's fetch cap: the most image the server will pull from a signed URL.
export const MAX_ATTACHED_BYTES = 20 * 1024 * 1024;

// URL keys accepted on a file handle, in preference order. `download_url` is the
// OpenAI Apps SDK name and stays first; the rest cover naming drift across hosts
// and the in-progress MCP file-upload drafts (SEP-2356/1306 use `uri`). Accepting
// alternates is free recovery — but it widens what the server will fetch, which
// is why the scheme guard below ships in the same change, not after.
const URL_KEYS = ["download_url", "url", "uri", "href", "file_url"] as const;

// Content-type keys, covering snake/camel drift between hosts.
const MIME_KEYS = ["mime_type", "mimeType"] as const;

// INLINE DELIVERY IS DELIBERATELY NOT SUPPORTED (removed 2026-08-30). An earlier
// draft accepted base64 bytes in `data`/`blob` and `data:` URLs (the SEP-1306
// shape) on the theory that a host might switch to inline delivery. It could not
// work as shipped and it broke this module's own guarantee: the JSON-RPC body is
// parsed by `express.json()`, whose 100KB limit rejects any real photo with a 413
// raised BEFORE bearer auth, before the HTTP probe, and before the handler — a
// silent, unlogged failure, which is precisely the class of failure this whole
// change exists to eliminate. Accommodating a 20MB photo would mean buffering
// ~27MB of base64 JSON per `/mcp` POST before the caller is even authenticated,
// a real memory-amplification cost paid for a delivery shape no host is known to
// send. So a `data:` URL is now refused by the scheme guard like any other
// non-https reference, and lands as the named `bad_scheme` outcome. If a host
// ever does inline a file, `photo_intake_request` will record the key it used and
// we can add the path deliberately, with a body limit chosen for it.

// Log-record caps. Key names are safe for credentials, but a hostile host could
// key a handle by an identifier (`{"file-abc123": …}`), so the record can never
// grow without bound: at most 20 keys, each at most 64 characters.
const MAX_LOGGED_KEYS = 20;
const MAX_KEY_LENGTH = 64;

// `declaredType` is the second (and last) value copied into a log record. A
// handle's `mime_type` is host- and model-writable, so it is truncated: a real
// media type is well under this, and a hostile one cannot pad a Loki line.
const MAX_MIME_LENGTH = 64;

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

export type UnusableReason = "not_an_object" | "no_url" | "empty_url" | "bad_scheme";

export type Delivery =
  | { kind: "fetchable"; channel: Channel; urlKey: string; url: string; scheme: string; host: string; mimeType?: string }
  | { kind: "unusable"; channel: Channel; reason: UnusableReason }
  | { kind: "absent" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

// The `image` ARGUMENT as the host sent it.
export function describeArgument(image: unknown): Shape {
  return shapeOf(image);
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

// ---- SSRF guard ------------------------------------------------------------
//
// `image.download_url` is a MODEL-WRITABLE argument that the server fetches from
// inside the cluster, so this decides what a socket may be opened to.
//
// THE BUG THIS REPLACES (2026-08-30). The first version classified loopback by
// STRING PREFIX — `host.startsWith("127.")` — which is not a test of the address
// at all, only of its spelling. `http://127.evil.com/`,
// `http://127.attacker.internal/` and `http://127.0.0.1.nip.io/` are all ordinary
// DNS names that pass a prefix test, so an attacker-controlled name walked
// straight through over plaintext http, and because `redirectTarget` revalidates
// with this same function, the "https://host/ → http://169.254.169.254/" bypass
// the guard was written to close was still open one DNS name away.
//
// So: never decide on characters. Ask `net.isIP` whether the hostname IS an IP
// literal and, if it is, classify the PARSED value numerically. WHATWG `URL`
// normalizes the exotic IPv4 spellings for us before we get here — `2130706433`,
// `0x7f000001` and `127.1` all arrive as `127.0.0.1` — so the numeric rules below
// are the whole decision.
//
// WHAT IS ALLOWED:
//   https + a public IP literal            the real delivery path
//   https + a DNS name                     the real delivery path (see the residual below)
//   http  + a loopback IP literal          TEST FIXTURES ONLY (see loopbackFetchAllowed)
// Everything else is refused before a socket is opened: any other scheme (file:,
// gopher:, data:), any http to a non-loopback host, and — new — https to a
// loopback, private, link-local, unique-local, CGNAT, multicast or unspecified
// address, which the old guard allowed outright. `https://169.254.169.254/`
// reached cloud metadata under the previous rules; it does not now.
//
// RESIDUAL, STATED PLAINLY: a DNS NAME that RESOLVES to a private address is NOT
// blocked here, and this guard does not claim to block it. Deciding on resolution
// would mean a DNS lookup — I/O this module deliberately does not do — and even
// in the fetch path it would not close the hole: undici re-resolves when it
// connects, so a rebinding record can answer public to our check and private to
// the socket. Pinning the checked address into the connection is the only real
// fix and it is not available through `fetch`. The containment that actually
// holds is at the network layer (the cluster's default-deny egress policy), and
// `fetch.host` is logged precisely so a name pointed somewhere it should not be
// is visible after the fact. Treat this as the known limit of the guard, not as
// coverage it has.
export interface FetchTarget {
  scheme: string;
  host: string;
}

// Loopback over plaintext http exists ONLY so the integration fixtures — a local
// HTTP server standing in for a signed URL — are fetchable. It is a liability in
// production (a foothold for reaching anything bound to the pod's own loopback),
// so it is gated to the test runner rather than shipped enabled. There is no
// production opt-in on purpose: an escape hatch here is the hole itself.
export function loopbackFetchAllowed(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
}

type HostVerdict = "loopback" | "internal" | "public_ip" | "name";

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    let value = 0;
    for (const char of part) {
      const digit = char.charCodeAt(0) - 48;
      if (digit < 0 || digit > 9) return null;
      value = value * 10 + digit;
    }
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

// Text → 16 bytes. `net.isIP` has already accepted the syntax, so this only has
// to place the groups: everything before `::` is left-aligned, everything after
// is right-aligned, and a trailing dotted quad expands to the last two groups.
function parseIpv6(text: string): Uint8Array | null {
  const zone = text.indexOf("%");
  const address = zone >= 0 ? text.slice(0, zone) : text;
  const gap = address.indexOf("::");
  const headText = gap < 0 ? address : address.slice(0, gap);
  const tailText = gap < 0 ? "" : address.slice(gap + 2);

  const expand = (source: string): number[] | null => {
    if (source.length === 0) return [];
    const groups: number[] = [];
    for (const part of source.split(":")) {
      if (part.includes(".")) {
        const octets = parseIpv4(part);
        if (!octets) return null;
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
        continue;
      }
      if (part.length === 0 || part.length > 4) return null;
      const value = Number.parseInt(part, 16);
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
      groups.push(value);
    }
    return groups;
  };

  const head = expand(headText);
  const tail = expand(tailText);
  if (!head || !tail) return null;
  const total = head.length + tail.length;
  if (gap < 0 ? total !== 8 : total > 8) return null;

  const bytes = new Uint8Array(16);
  head.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  const offset = 8 - tail.length;
  tail.forEach((group, index) => {
    bytes[(offset + index) * 2] = group >> 8;
    bytes[(offset + index) * 2 + 1] = group & 0xff;
  });
  return bytes;
}

// RFC 1918 private space, RFC 3927 link-local (which is where the cloud metadata
// address 169.254.169.254 lives), RFC 6598 CGNAT, loopback, "this network", and
// everything from 224/4 up (multicast, reserved, broadcast).
function classifyIpv4(octets: readonly number[]): HostVerdict {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return "loopback";
  if (a === 0) return "internal";
  if (a === 10) return "internal";
  if (a === 172 && b >= 16 && b <= 31) return "internal";
  if (a === 192 && b === 168) return "internal";
  if (a === 169 && b === 254) return "internal";
  if (a === 100 && b >= 64 && b <= 127) return "internal";
  if (a === 198 && (b === 18 || b === 19)) return "internal";
  if (a >= 224) return "internal";
  return "public_ip";
}

// Several IPv6 forms carry an IPv4 address in their low bytes. Classifying the
// EMBEDDED address is what stops the entire IPv4 ruleset from being bypassed by
// rewriting the target in v6 notation (`::ffff:169.254.169.254`).
function embeddedIpv4(bytes: Uint8Array): number[] | null {
  const low = [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  // 2002::/16 — 6to4, address in bytes 2..5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return [bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!];
  const zeroPrefix = bytes.subarray(0, 10).every((byte) => byte === 0);
  // ::ffff:a.b.c.d — IPv4-mapped; ::a.b.c.d — deprecated IPv4-compatible.
  if (zeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff) return low;
  if (zeroPrefix && bytes[10] === 0 && bytes[11] === 0) return low;
  // 64:ff9b::/96 — the NAT64 well-known prefix.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.subarray(4, 12).every((byte) => byte === 0)
  )
    return low;
  return null;
}

function classifyIpv6(bytes: Uint8Array): HostVerdict {
  if (bytes.every((byte) => byte === 0)) return "internal"; // ::
  if (bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "loopback"; // ::1
  const embedded = embeddedIpv4(bytes);
  if (embedded) return classifyIpv4(embedded);
  if ((bytes[0]! & 0xfe) === 0xfc) return "internal"; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return "internal"; // fe80::/10 link-local
  if (bytes[0] === 0xff) return "internal"; // ff00::/8 multicast
  return "public_ip";
}

// What the hostname IS — an address of some class, or a name. Exported for the
// tests that pin each bypass class; the fetch decision lives in fetchTargetOf.
export function classifyHost(host: string): HostVerdict {
  const family = isIP(host);
  if (family === 4) {
    const octets = parseIpv4(host);
    return octets ? classifyIpv4(octets) : "internal";
  }
  if (family === 6) {
    const bytes = parseIpv6(host);
    return bytes ? classifyIpv6(bytes) : "internal";
  }
  // `localhost` is the one NAME treated as an address: every resolver in practice
  // maps it to 127.0.0.1/::1, so refusing to acknowledge that would only make the
  // fixture allowance inconsistent, not safer.
  if (host.toLowerCase() === "localhost") return "loopback";
  return "name";
}

export function fetchTargetOf(raw: string): FetchTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // An unparsable reference is refused on the same grounds and reported under
    // the same reason: whatever it is, the server will not open it.
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) return null;
  const verdict = classifyHost(host);

  if (parsed.protocol === "https:") {
    // A DNS name is allowed because the real delivery path is a signed URL on a
    // CDN domain we cannot enumerate; see the residual note above.
    return verdict === "public_ip" || verdict === "name" ? { scheme: "https", host } : null;
  }
  return verdict === "loopback" && loopbackFetchAllowed() ? { scheme: "http", host } : null;
}

// Classify ONE file handle. Never throws, never returns null: an unusable shape
// is a first-class result carrying WHY, which is the whole point of this module.
function classifyHandle(entry: unknown, channel: Channel): Delivery {
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
    // A `data:` URL lands here too and is refused by the guard as `bad_scheme` —
    // see the inline-delivery note at the top of this file.
    const target = fetchTargetOf(url);
    if (!target) return { kind: "unusable", channel, reason: "bad_scheme" };
    return { kind: "fetchable", channel, urlKey, url, scheme: target.scheme, host: target.host, mimeType };
  }

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
  const argDelivery = argImage === undefined ? null : classifyHandle(argImage, "argument");

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
//
// `declaredType` is the one part of this that reaches a log line, so it is capped
// here (MAX_MIME_LENGTH): it is copied from a host- and model-writable
// `mime_type`, and the shape-not-values rule allows it only as a BOUNDED
// exception. `contentType` — the value handed to the decoder — is deliberately
// left uncapped: truncating it would turn a long-but-valid media type into a
// silent decode failure, and it never reaches Loki.
export function resolveContentType(
  declared: string | undefined,
  bytes: Buffer,
): { contentType: string; declaredType: string; sniffedType?: string } {
  const trimmed = declared && declared.trim().length > 0 ? declared.trim() : OCTET_STREAM;
  const sniffedType = sniffImageType(bytes);
  return {
    contentType: sniffedType ?? trimmed,
    declaredType: trimmed.slice(0, MAX_MIME_LENGTH),
    sniffedType,
  };
}

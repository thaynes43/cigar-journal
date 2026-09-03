// The polite HTTP layer every crawl goes through (ADR-006: rate-limited, honors
// robots, identifying UA). One global limiter serializes ALL requests — product
// pages, the sitemap, and photo downloads alike — at ≥ MIN_INTERVAL_MS plus a
// little jitter, so a run never hammers a vendor. A fixed UA, a 15s timeout, and
// one retry on 5xx/network round it out. Injectable clock/sleep/fetch keep it
// unit-testable without real time or network.

export const CRAWLER_UA = "cigar-journal-crawler/1.0 (+https://cigars.haynesnetwork.com)";
// The product token robots.txt is matched against (foxcigar bans named bots; we
// are not one of them and fall under `*`).
export const CRAWLER_UA_TOKEN = "cigar-journal-crawler";

// The floor is load-bearing, not a default: a run must not fetch faster than
// this against a live vendor. Tests pass an explicit sub-floor interval with
// `allowFastInterval` to keep the suite quick; production never sets it.
const MIN_INTERVAL_MS = 2500;
const MIN_INTERVAL_FLOOR_MS = 2000;
const JITTER_MS = 500;
const TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = 1000;

// --- being told to slow down (#270, first unattended fleet run) --------------
// A 429 (or a 503, which is the other spelling of "not now") is the vendor
// stating its own rate rule, and until 2026-09-03 this fetcher ignored it: only
// a 5xx was retried, so a 429 was returned as a plain non-200 that ingest
// counted as a page error and moved straight on to the next URL — at the same
// interval, which is what kept the limit tripped.
//
// Cigarworld.de measured it exactly. Its Apache serves
//   HTTP 429, `retry-after: 6`
//   <h1>PageViewCount restriction</h1><p>Bitte warten Sie 5 Sekunden…</p>
// after ~26 requests at the adapter's 4s interval, and every request that
// follows counts toward the same window, so the counter never drains: the
// 2026-09-03 02:00 fleet drain fetched 29 pages and then took 47 consecutive
// 429s. A single pause of the six seconds the shop asked for would have cleared
// all 47.
//
// So a throttled response now does two things. It is RETRIED ONCE after the
// delay the vendor named — and, more importantly, the delay is put on the
// SHARED LIMITER (`cooldownUntil`) rather than only on this call, because the
// vendor's rule is about the connection, not about one URL. A second 429 is
// returned rather than thrown: one page error is a page error, and throwing
// would cost the vendor its whole run.
const THROTTLED_STATUSES = new Set([429, 503]);
// What to wait when a throttled response names no `Retry-After`. Deliberately
// well above the politeness floor — the vendor has just said we are too fast.
const THROTTLED_DEFAULT_MS = 5_000;
// The most any vendor's `Retry-After` can hold a run for. A misconfigured (or
// hostile) header naming an hour must not park the fleet's nightly deadline.
const RETRY_AFTER_CAP_MS = 60_000;

// Every binary a crawl downloads is an image bound for the photo pipeline, so
// one cap serves them all. The pipeline downsamples anything larger than we
// serve, so this only bounds what we will pull down and decode. Deliberately
// tighter than the two USER photo paths (20MB, apps/web MAX_UPLOAD_BYTES and
// @cj/mcp MAX_ATTACHED_BYTES): a vendor product shot the crawler pulls
// unattended has no business being that large. Callers pass it to fetchBinary —
// a request without a `maxBytes` is unbounded, which is why the download paths
// always name it.
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface FetchTextResult {
  status: number;
  body: string;
}

export interface FetchBinaryResult {
  status: number;
  body: Buffer;
  contentType: string;
}

export interface Fetcher {
  fetchText(url: string): Promise<FetchTextResult>;
  // `maxBytes` bounds the download itself — the body is never fully buffered
  // before the cap is applied. Throws MaxBytesExceededError over the cap.
  fetchBinary(url: string, maxBytes?: number): Promise<FetchBinaryResult>;
  // Pages (text fetches) pulled so far — folded into crawl_runs.stats.
  readonly pagesFetched: number;
}

export interface FetcherOptions {
  userAgent?: string;
  minIntervalMs?: number;
  jitterMs?: number;
  timeoutMs?: number;
  // Optional hard cap on text pages; the fetcher throws once exceeded so a
  // misconfigured run can't walk an entire catalog unbounded.
  maxPages?: number;
  // Test seams.
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  // Permits sub-floor intervals in tests only; ignored-to-floor otherwise.
  allowFastInterval?: boolean;
}

export class MaxPagesExceededError extends Error {
  constructor(readonly maxPages: number) {
    super(`Crawl exceeded the max-pages guard (${maxPages}).`);
    this.name = "MaxPagesExceededError";
  }
}

// A download refused for its size. Thrown rather than returned so no caller can
// forget the check: the bytes do not exist to be used.
export class MaxBytesExceededError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly url: string,
  ) {
    super(`Download exceeded the ${maxBytes}-byte cap: ${url}`);
    this.name = "MaxBytesExceededError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const ua = options.userAgent ?? CRAWLER_UA;
  const requested = options.minIntervalMs ?? MIN_INTERVAL_MS;
  const minInterval = options.allowFastInterval ? requested : Math.max(requested, MIN_INTERVAL_FLOOR_MS);
  const jitter = options.jitterMs ?? JITTER_MS;
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastDispatch = Number.NEGATIVE_INFINITY;
  // The earliest a NEXT request may go out, independent of the interval. Only a
  // throttled response moves it, and it applies to every URL because a vendor's
  // rate rule is about us, not about the page we asked for.
  let cooldownUntil = Number.NEGATIVE_INFINITY;
  let pages = 0;

  // What the vendor asked us to wait, in ms — the delta-seconds spelling and the
  // HTTP-date spelling, both capped. Null when the header is absent or unreadable,
  // which the caller reads as "throttled, but it did not say for how long".
  function retryAfterMs(res: Response): number | null {
    const raw = res.headers.get("retry-after");
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_CAP_MS);
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    return Math.min(Math.max(at - now(), 0), RETRY_AFTER_CAP_MS);
  }

  // Serialize every request behind the shared limiter, waiting out the interval —
  // and any cooldown a throttled response left behind, whichever is later.
  async function throttle(): Promise<void> {
    const readyAt = Math.max(lastDispatch + minInterval + Math.floor(random() * jitter), cooldownUntil);
    const wait = readyAt - now();
    if (wait > 0) await sleep(wait);
    lastDispatch = now();
  }

  async function request(url: string): Promise<Response> {
    // One retry on a 429/503, a 5xx, or a network/timeout error. A throttled
    // response also arms the shared cooldown, so the wait is served by `throttle`
    // at the top of the next iteration — and by every request after this one.
    for (let attempt = 0; attempt < 2; attempt++) {
      await throttle();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await doFetch(url, {
          headers: { "user-agent": ua },
          signal: controller.signal,
          redirect: "follow",
        });
        clearTimeout(timer);
        if (THROTTLED_STATUSES.has(res.status)) {
          cooldownUntil = now() + (retryAfterMs(res) ?? THROTTLED_DEFAULT_MS);
          if (attempt === 0) continue;
          // Still throttled after waiting it out: hand the status back so the
          // caller records ONE page error. The cooldown stays armed either way,
          // which is the half that keeps the rest of the run out of the hole.
          return res;
        }
        if (res.status >= 500 && attempt === 0) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        return res;
      } catch (error) {
        clearTimeout(timer);
        if (attempt === 0) {
          await sleep(RETRY_BACKOFF_MS);
          continue;
        }
        throw error;
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new Error(`fetch failed: ${url}`);
  }

  return {
    get pagesFetched() {
      return pages;
    },
    async fetchText(url: string): Promise<FetchTextResult> {
      if (options.maxPages != null && pages >= options.maxPages) {
        throw new MaxPagesExceededError(options.maxPages);
      }
      const res = await request(url);
      pages += 1;
      const body = await res.text();
      return { status: res.status, body };
    },
    // Bounded in two layers when the caller names a cap, because either layer
    // alone leaks: a declared content-length can be absent or a lie, and by the
    // time a buffered body could be measured it is already in memory.
    async fetchBinary(url: string, maxBytes?: number): Promise<FetchBinaryResult> {
      const res = await request(url);
      const contentType = res.headers.get("content-type") ?? "application/octet-stream";
      if (maxBytes == null) {
        return { status: res.status, body: Buffer.from(await res.arrayBuffer()), contentType };
      }

      // Layer 1: refuse an honestly-declared oversize body without reading it.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel();
        throw new MaxBytesExceededError(maxBytes, url);
      }
      if (!res.body) return { status: res.status, body: Buffer.alloc(0), contentType };

      // Layer 2: count as we read and abort the moment the cap is crossed, so an
      // unset or understated length still costs at most one chunk past it.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new MaxBytesExceededError(maxBytes, url);
        }
        chunks.push(value);
      }
      return { status: res.status, body: Buffer.concat(chunks), contentType };
    },
  };
}

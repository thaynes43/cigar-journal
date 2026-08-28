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
  fetchBinary(url: string): Promise<FetchBinaryResult>;
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
  let pages = 0;

  // Serialize every request behind the shared limiter, waiting out the interval.
  async function throttle(): Promise<void> {
    const wait = minInterval + Math.floor(random() * jitter) - (now() - lastDispatch);
    if (wait > 0) await sleep(wait);
    lastDispatch = now();
  }

  async function request(url: string): Promise<Response> {
    // One retry on a 5xx or a network/timeout error; the second failure throws.
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
    async fetchBinary(url: string): Promise<FetchBinaryResult> {
      const res = await request(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        body: buffer,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
  };
}

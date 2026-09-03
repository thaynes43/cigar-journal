import { describe, it, expect } from "vitest";
import { createFetcher, MaxBytesExceededError } from "./fetcher.js";
import { loadFixture } from "../testing/fixtures.js";

// The download bound (issue: brand images). Every assertion here is about bytes
// that must NOT reach memory, so the stub streams are instrumented: a body the
// fetcher refuses is a body it never pulled a chunk from.

const CAP = 1024;

interface StreamProbe {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelled: () => boolean;
}

// A stream that hands out `chunkSize` bytes per pull, up to `total`, counting
// pulls and cancellation. `total: Infinity` never ends on its own — the only way
// out is the reader cancelling, which is exactly what the cap must do.
function probeStream(total: number, chunkSize: number): StreamProbe {
  let pulls = 0;
  let cancelled = false;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulls: () => pulls, cancelled: () => cancelled };
}

// A fetcher with the politeness layer neutralized — this file tests the body
// bound, not the throttle.
function fetcherFor(response: () => Response) {
  return createFetcher({
    minIntervalMs: 0,
    jitterMs: 0,
    allowFastInterval: true,
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0,
    fetchImpl: () => Promise.resolve(response()),
  });
}

describe("fetchBinary size bound", () => {
  it("refuses a declared over-cap content-length without reading a single chunk", async () => {
    const probe = probeStream(64 * 1024, 4096);
    const fetcher = fetcherFor(
      () =>
        new Response(probe.stream, {
          headers: { "content-type": "image/jpeg", "content-length": String(40 * 1024 * 1024) },
        }),
    );

    await expect(fetcher.fetchBinary("https://example.test/original.jpg", CAP)).rejects.toBeInstanceOf(
      MaxBytesExceededError,
    );
    // The 40MB body is 10k chunks; the fetcher took none of them. The one pull
    // that can show up here is the stream's own read-ahead (WHATWG default
    // highWaterMark), which happens whether or not anyone reads.
    expect(probe.pulls()).toBeLessThanOrEqual(1);
    expect(probe.cancelled()).toBe(true);
  });

  it("aborts an over-cap stream at the cap when the length is unset — at most one chunk past it", async () => {
    // No content-length at all, and a body that would never stop: the layer-1
    // check cannot help, so only the running count can end this.
    const probe = probeStream(Number.POSITIVE_INFINITY, 256);
    const fetcher = fetcherFor(() => new Response(probe.stream, { headers: { "content-type": "image/jpeg" } }));

    await expect(fetcher.fetchBinary("https://example.test/endless.jpg", CAP)).rejects.toBeInstanceOf(
      MaxBytesExceededError,
    );
    // 1024-byte cap, 256-byte chunks: four fill it, the fifth crosses and stops
    // the read — plus the stream's one-chunk read-ahead. An endless body ends
    // in six pulls, which is the whole claim.
    expect(probe.pulls()).toBeLessThanOrEqual(6);
    expect(probe.cancelled()).toBe(true);
  });

  it("aborts a body that understates its own content-length", async () => {
    const probe = probeStream(8 * CAP, 512);
    const fetcher = fetcherFor(
      () => new Response(probe.stream, { headers: { "content-type": "image/jpeg", "content-length": "10" } }),
    );

    await expect(fetcher.fetchBinary("https://example.test/liar.jpg", CAP)).rejects.toBeInstanceOf(
      MaxBytesExceededError,
    );
    expect(probe.cancelled()).toBe(true);
  });

  it("returns a body at exactly the cap — the bound is inclusive", async () => {
    const probe = probeStream(CAP, 256);
    const fetcher = fetcherFor(
      () =>
        new Response(probe.stream, {
          headers: { "content-type": "image/png", "content-length": String(CAP) },
        }),
    );

    const result = await fetcher.fetchBinary("https://example.test/exact.png", CAP);
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(CAP);
    expect(result.contentType).toBe("image/png");
  });

  it("reassembles a multi-chunk under-cap body byte for byte", async () => {
    const bytes = Buffer.from("brand-logo-bytes");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, 6)));
        controller.enqueue(new Uint8Array(bytes.subarray(6)));
        controller.close();
      },
    });
    const fetcher = fetcherFor(() => new Response(stream, { headers: { "content-type": "image/jpeg" } }));

    const result = await fetcher.fetchBinary("https://example.test/logo.jpg", CAP);
    expect(result.body.equals(bytes)).toBe(true);
  });

  it("still buffers unbounded when no cap is passed — the cap is opt-in per call", async () => {
    const probe = probeStream(4 * CAP, 512);
    const fetcher = fetcherFor(() => new Response(probe.stream, { headers: { "content-type": "image/jpeg" } }));

    const result = await fetcher.fetchBinary("https://example.test/unbounded.jpg");
    expect(result.body.length).toBe(4 * CAP);
  });

  it("carries the cap and the url on the error, so a caller can report which download it refused", async () => {
    const fetcher = fetcherFor(
      () =>
        new Response(probeStream(64, 64).stream, {
          headers: { "content-length": String(99 * 1024 * 1024) },
        }),
    );

    const error = await fetcher
      .fetchBinary("https://upload.wikimedia.org/original.jpg", CAP)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MaxBytesExceededError);
    expect((error as MaxBytesExceededError).maxBytes).toBe(CAP);
    expect((error as MaxBytesExceededError).url).toBe("https://upload.wikimedia.org/original.jpg");
  });
});

// =============================================================================
// BEING TOLD TO SLOW DOWN (#270). Cigarworld.de's Apache answers 429 with
// `Retry-After: 6` and a `PageViewCount restriction` body once its page-view
// window is crossed — measured in-cluster 2026-09-03 at 26 requests on the
// adapter's old 4s interval. The fetcher used to retry only 5xx, so the 429 came
// back as a plain non-200 and the walk moved straight on at the same interval,
// which is what kept the window full: the 02:00 fleet drain fetched 29 pages and
// then took 47 consecutive 429s.
//
// The fixture below is the vendor's ACTUAL 135-byte body.
// =============================================================================

const PAGEVIEW_429 = loadFixture("live-429-pageviewcount.html", "cigarworld-de");

// A fetcher over a scripted sequence of responses with a CONTROLLED clock: the
// injected `sleep` advances it, so what the limiter waited is a number this file
// can assert on rather than real elapsed time.
function scriptedFetcher(responses: Array<() => Response>, options: { minIntervalMs?: number } = {}) {
  let clock = 0;
  const slept: number[] = [];
  let call = 0;
  const fetcher = createFetcher({
    minIntervalMs: options.minIntervalMs ?? 1000,
    jitterMs: 0,
    allowFastInterval: true,
    now: () => clock,
    random: () => 0,
    sleep: (ms: number) => {
      slept.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    fetchImpl: () => {
      const next = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return Promise.resolve(next());
    },
  });
  return { fetcher, slept, calls: () => call };
}

const throttled = (headers: Record<string, string> = { "retry-after": "6" }) =>
  new Response(PAGEVIEW_429, { status: 429, headers });
const ok = () => new Response("<html>fine</html>", { status: 200 });

describe("a throttled response (429/503)", () => {
  it("waits the Retry-After the vendor named and retries once, then succeeds", async () => {
    const { fetcher, slept, calls } = scriptedFetcher([throttled, ok]);

    const result = await fetcher.fetchText("https://www.cigarworld.de/zigarren/kuba/regulares/x-01008_64");

    expect(result.status).toBe(200);
    expect(calls()).toBe(2);
    // 6s, not the 1s interval: the vendor's number, not ours.
    expect(slept).toContain(6000);
  });

  it("carries the vendor's cooldown to the NEXT url, not just to the retry", async () => {
    // THE SHAPE THAT PRODUCED 47 ERRORS. A vendor still throttling after the
    // retry hands back a 429, and the walk moves on to the next candidate — at
    // the ordinary 1s interval, straight back into the window it just tripped.
    // The cooldown is what stops that: it is re-armed by the second 429 and the
    // next URL waits it out.
    const { fetcher, slept } = scriptedFetcher([throttled, throttled, ok]);

    const first = await fetcher.fetchText("https://www.cigarworld.de/zigarren/a");
    expect(first.status).toBe(429);

    const before = slept.length;
    const second = await fetcher.fetchText("https://www.cigarworld.de/zigarren/b");

    expect(second.status).toBe(200);
    // 6s from the standing cooldown, not the 1000ms this fetcher's interval
    // would have dispatched at.
    expect(slept.slice(before)).toEqual([6000]);
  });

  it("returns the 429 rather than throwing when the vendor is still throttling", async () => {
    // A throw here would cost the vendor its whole run; one page error is the
    // right price for one page.
    const { fetcher, calls } = scriptedFetcher([throttled]);

    const result = await fetcher.fetchText("https://www.cigarworld.de/zigarren/a");

    expect(result.status).toBe(429);
    expect(result.body).toContain("PageViewCount restriction");
    expect(calls()).toBe(2); // one retry, and only one
  });

  it("falls back to a fixed delay when the vendor names no Retry-After", async () => {
    const { fetcher, slept } = scriptedFetcher([() => throttled({}), ok]);

    await fetcher.fetchText("https://example.test/a");

    expect(slept).toContain(5000);
  });

  it("refuses to be parked for an hour by an outsized Retry-After", async () => {
    const { fetcher, slept } = scriptedFetcher([() => throttled({ "retry-after": "3600" }), ok]);

    await fetcher.fetchText("https://example.test/a");

    expect(Math.max(...slept)).toBe(60_000);
  });

  it("reads the HTTP-date spelling of Retry-After", async () => {
    // `now()` starts at 0 in this harness, so an absolute date 4s past the epoch
    // is a 4s wait. Both spellings are legal and vendors serve both.
    const { fetcher, slept } = scriptedFetcher([() => throttled({ "retry-after": new Date(4000).toUTCString() }), ok]);

    await fetcher.fetchText("https://example.test/a");

    expect(slept).toContain(4000);
  });

  it("treats a 503 the same way, and leaves the 5xx backoff alone", async () => {
    const { fetcher, slept } = scriptedFetcher([
      () => new Response("busy", { status: 503, headers: { "retry-after": "2" } }),
      ok,
    ]);
    await fetcher.fetchText("https://example.test/a");
    expect(slept).toContain(2000);

    const five = scriptedFetcher([() => new Response("boom", { status: 500 }), ok]);
    const result = await five.fetcher.fetchText("https://example.test/b");
    expect(result.status).toBe(200);
    expect(five.slept).toContain(1000); // RETRY_BACKOFF_MS, unchanged
  });
});

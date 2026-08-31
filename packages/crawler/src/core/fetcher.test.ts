import { describe, it, expect } from "vitest";
import { createFetcher, MaxBytesExceededError } from "./fetcher.js";

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

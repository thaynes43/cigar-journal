import { describe, it, expect } from "vitest";
import { PhotoNotFoundError } from "@cj/domain";
import {
  domainErrorResponse,
  smokePhotoHeaders,
  PHOTO_PRIVATE_CACHE,
  PHOTO_PUBLIC_CACHE,
  PHOTO_VARY,
} from "./photo-http";

// The smoke-photo cache policy is a security boundary, not a performance knob,
// so the exact header strings are pinned here: the full-size and thumb routes
// both render them, and a shared cache obeys the literal directives.

describe("smokePhotoHeaders", () => {
  it("states the public variant exactly", () => {
    expect(smokePhotoHeaders("image/jpeg", true)).toEqual({
      Vary: "Cookie",
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=300, must-revalidate",
    });
  });

  it("states the owner variant exactly", () => {
    expect(smokePhotoHeaders("image/webp", false)).toEqual({
      Vary: "Cookie",
      "Content-Type": "image/webp",
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  it("varies both variants on Cookie", () => {
    // One URL serves owner bytes or public bytes depending on the session. Without
    // Vary a shared cache may hand one viewer's variant — and its cache scope — to
    // another.
    for (const isPublic of [true, false]) {
      expect(smokePhotoHeaders("image/jpeg", isPublic).Vary).toBe("Cookie");
    }
  });

  it("keeps the public variant revocable", () => {
    // The regression: public bytes were cached `immutable` for a year, so deleting
    // a photo or flipping the journal back to private left it served from shared
    // caches for the rest of that year. The revocation window is this max-age, and
    // `immutable` would suppress the revalidation that closes it.
    const cacheControl = smokePhotoHeaders("image/jpeg", true)["Cache-Control"]!;
    expect(cacheControl).not.toContain("immutable");
    expect(cacheControl).toContain("max-age=300");
    expect(cacheControl).toContain("must-revalidate");
    expect(PHOTO_PUBLIC_CACHE).toBe(cacheControl);
  });

  it("keeps the owner variant an immutable year", () => {
    // Owner bytes are content-addressed and never enter a shared cache, so the
    // long immutable TTL costs nothing and is worth keeping.
    expect(PHOTO_PRIVATE_CACHE).toBe("private, max-age=31536000, immutable");
    expect(smokePhotoHeaders("image/jpeg", false)["Cache-Control"]).toBe(PHOTO_PRIVATE_CACHE);
  });
});

describe("domainErrorResponse", () => {
  it("carries the supplied headers onto the error response", () => {
    // An error response is cacheable too: a 404 without Vary can be replayed to a
    // viewer whose cookie would have earned the bytes.
    const res = domainErrorResponse(new PhotoNotFoundError(), PHOTO_VARY);
    expect(res.status).toBe(404);
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("still maps a domain error with no headers argument", () => {
    // Five other routes call it with one argument; the added parameter must stay
    // optional for them.
    expect(domainErrorResponse(new PhotoNotFoundError()).status).toBe(404);
  });

  it("re-throws a non-domain error", () => {
    // A genuine fault must reach Next as a 500 rather than be flattened into a
    // status the caller could mistake for a routine answer.
    const boom = new Error("boom");
    expect(() => domainErrorResponse(boom)).toThrow(boom);
  });
});

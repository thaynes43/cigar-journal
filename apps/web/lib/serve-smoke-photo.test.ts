import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PhotoNotFoundError, type Principal } from "@cj/domain";
import { createHarness, type DomainHarness } from "@cj/domain/testing";
import { resolveViewablePhoto } from "./serve-smoke-photo";

// The full-size and thumb photo routes share this resolver, so its answers are
// both routes' answers. Only the unresolvable paths are exercised: serving real
// bytes needs the S3 bucket, which no test has, and the resolution decision is
// storage-independent anyway.

describe("resolveViewablePhoto", () => {
  let h: DomainHarness;
  let viewer: Principal;

  beforeAll(async () => {
    h = await createHarness();
    viewer = await h.createUser("photo-resolver@example.com");
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  // A photo id is a raw URL path segment bound for a uuid column. Before the shape
  // guard a non-uuid reached the query and raised Postgres 22P02 — not a
  // DomainError, so it escaped as a 500 on a public URL instead of the 404 the
  // route now answers.
  const malformed = ["not-a-uuid", "123", ""];

  it.each(malformed)("rejects the malformed id %o for an anonymous viewer", async (id) => {
    await expect(resolveViewablePhoto(h.deps, null, id)).rejects.toBeInstanceOf(PhotoNotFoundError);
  });

  it.each(malformed)("rejects the malformed id %o for a signed-in viewer", async (id) => {
    await expect(resolveViewablePhoto(h.deps, viewer, id)).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
  });

  // The guard must not change what an id that is merely absent earns: a
  // well-formed unknown uuid was already a 404 and still is, so the malformed and
  // the unknown stay indistinguishable and neither leaks a photo's existence.
  it("rejects a well-formed but unknown id for either viewer", async () => {
    const unknown = randomUUID();
    await expect(resolveViewablePhoto(h.deps, null, unknown)).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
    await expect(resolveViewablePhoto(h.deps, viewer, unknown)).rejects.toBeInstanceOf(
      PhotoNotFoundError,
    );
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHarness, newRequestId, type DomainHarness } from "@cj/domain/testing";
import { openPhotoDrop, type Principal } from "@cj/domain";
import { createMemoryPhotoStorage } from "@cj/photos";

// One photo inside a drop, over HTTP (ADR-014, issue #263): the chip tap and the
// Remove button the page fires with no form and no confirmation, plus the
// thumbnail route those rows render.
//
// Two things here are not visible from the domain tests. The Remove must take
// the bucket objects with the row — a leaked object nobody can reach again is
// exactly what an anonymous surface must not accumulate — and the thumbnail must
// be served `no-store`, because the token rides the URL and a shared cache would
// be caching the credential along with the bytes.
//
// The storage is the in-memory one with a ledger of the keys currently in it.
// Asserting on the ledger rather than on a key spelled out here is deliberate:
// the object key's uuid is NOT the photo row's id (the domain mints its own), so
// a test that rebuilt the key from the response would be asserting a coincidence.
// What matters is that everything the upload wrote is what the removal takes.
vi.mock("@/lib/photos", async () => {
  const { createMemoryPhotoStorage } = await import("@cj/photos");
  const { MAX_UPLOAD_BYTES } = await import("@/lib/upload-limits");
  const inner = createMemoryPhotoStorage();
  const live = new Set<string>();
  const photoStorage = {
    async put(key: string, body: Buffer, contentType: string) {
      await inner.put(key, body, contentType);
      live.add(key);
    },
    get: (key: string) => inner.get(key),
    async delete(key: string) {
      await inner.delete(key);
      live.delete(key);
    },
  };
  return { photoStorage, photosEnabled: true, MAX_UPLOAD_BYTES, liveObjectKeys: live };
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface PhotoBody {
  photoId: string;
  kind: string;
  attached: boolean;
}

let dropMod: typeof import("../../route");
let photoMod: typeof import("./route");
let thumbMod: typeof import("./thumb/route");
let liveObjectKeys: Set<string>;

function stage(token: string): Promise<Response> {
  const form = new FormData();
  form.set("file", new File([PNG_1X1], "cigar.png", { type: "image/png" }));
  return dropMod.POST(
    new Request(`http://localhost/api/photo-drops/${token}`, { method: "POST", body: form }),
    { params: Promise.resolve({ token }) },
  );
}

function patch(token: string, id: string, body: unknown): Promise<Response> {
  return photoMod.PATCH(
    new Request(`http://localhost/api/photo-drops/${token}/photos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token, id }) },
  );
}

function del(token: string, id: string): Promise<Response> {
  return photoMod.DELETE(
    new Request(`http://localhost/api/photo-drops/${token}/photos/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ token, id }) },
  );
}

function thumb(token: string, id: string): Promise<Response> {
  return thumbMod.GET(new Request(`http://localhost/api/photo-drops/${token}/photos/${id}/thumb`), {
    params: Promise.resolve({ token, id }),
  });
}

describe("/api/photo-drops/[token]/photos/[id]", () => {
  let h: DomainHarness;
  let dbmod: typeof import("@cj/db");
  let user: Principal;
  let token: string;
  let photoDropId: string;

  beforeAll(async () => {
    h = await createHarness();
    process.env.DATABASE_URL = h.pg.url;
    process.env.BETTER_AUTH_URL = "https://cigars.example.com";
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";

    dropMod = await import("../../route");
    photoMod = await import("./route");
    thumbMod = await import("./thumb/route");
    ({ liveObjectKeys } = (await import("@/lib/photos")) as unknown as {
      liveObjectKeys: Set<string>;
    });
    dbmod = await import("@cj/db");
  }, 60_000);

  afterAll(async () => {
    await (dbmod.db as unknown as { $client: { end: () => Promise<void> } }).$client
      .end()
      .catch(() => {});
    await h?.stop();
  });

  beforeEach(async () => {
    h.setNow(new Date());
    user = await h.createUser(`drop-photo-${newRequestId()}@example.com`);
    const opened = await openPhotoDrop(h.deps, createMemoryPhotoStorage(), user);
    token = opened.token;
    photoDropId = opened.photoDropId;
  });

  it("reclassifies a photo on a chip tap", async () => {
    const photo = (await (await stage(token)).json()) as PhotoBody;
    expect(photo.kind).toBe("other");

    const res = await patch(token, photo.photoId, { kind: "band" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PhotoBody).kind).toBe("band");
  });

  it("refuses a kind that is not one of the five", async () => {
    const photo = (await (await stage(token)).json()) as PhotoBody;
    const res = await patch(token, photo.photoId, { kind: "portrait" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("removes the photo and its objects", async () => {
    liveObjectKeys.clear();
    const photo = (await (await stage(token)).json()) as PhotoBody;
    // Full-size and thumbnail, both keyed by the DROP — there is no smoke to key
    // by yet (ADR-014).
    expect([...liveObjectKeys]).toHaveLength(2);
    expect([...liveObjectKeys].every((key) => key.startsWith(`drop/${photoDropId}/`))).toBe(true);

    const res = await del(token, photo.photoId);
    expect(res.status).toBe(204);
    expect([...liveObjectKeys]).toEqual([]);

    // Gone from the drop, so a second Remove is a 404 rather than a second delete.
    expect((await del(token, photo.photoId)).status).toBe(404);
  });

  it("serves the thumbnail bytes, with a cache nothing may keep", async () => {
    const photo = (await (await stage(token)).json()) as PhotoBody;

    const res = await thumb(token, photo.photoId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("answers 404 for an id this link cannot address, malformed or not", async () => {
    for (const id of ["not-a-uuid", "3f2504e0-4f89-11d3-9a0c-0305e82c3301"]) {
      expect((await patch(token, id, { kind: "band" })).status).toBe(404);
      expect((await del(token, id)).status).toBe(404);
      expect((await thumb(token, id)).status).toBe(404);
    }
  });

  it("answers an unknown token 410 on every route", async () => {
    const photo = (await (await stage(token)).json()) as PhotoBody;

    expect((await patch("not-a-real-token", photo.photoId, { kind: "band" })).status).toBe(410);
    expect((await del("not-a-real-token", photo.photoId)).status).toBe(410);
    expect((await thumb("not-a-real-token", photo.photoId)).status).toBe(410);
  });
});

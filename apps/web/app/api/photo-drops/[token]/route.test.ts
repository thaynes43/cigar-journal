import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHarness, newRequestId, type DomainHarness } from "@cj/domain/testing";
import {
  claimPhotoDrop,
  openPhotoDrop,
  saveSmoke,
  MAX_PHOTOS_PER_DROP,
  type Principal,
} from "@cj/domain";
import { createMemoryPhotoStorage } from "@cj/photos";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

// The drop's state read and its upload endpoint (ADR-014, issue #263). Two
// things are under test that the domain's own tests cannot see: the ORDER the
// route runs its checks in, and the HTTP vocabulary the page reads.
//
// The drop link is MULTI-USE, so a rejected file cannot burn it the way the
// single-use `/u` link could — but it must not COUNT either, and that is what
// the rejection cases here pin: after four refusals the drop still holds
// exactly the photos it was given.
//
// Object storage is the in-memory implementation because the uploads have to
// SUCCEED to prove anything; the factory takes the real byte ceiling so the 413
// boundary here is the shipped one.
vi.mock("@/lib/photos", async () => {
  const { createMemoryPhotoStorage } = await import("@cj/photos");
  const { MAX_UPLOAD_BYTES } = await import("@/lib/upload-limits");
  return { photoStorage: createMemoryPhotoStorage(), photosEnabled: true, MAX_UPLOAD_BYTES };
});

// A real 1×1 PNG — the pipeline decodes it, so this exercises the whole path
// rather than a mocked-out one.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface PhotoBody {
  photoId: string;
  kind: string;
  attached: boolean;
}

interface StateBody {
  photoDropId: string;
  status: string;
  smokeId: string | null;
  photos: PhotoBody[];
}

function post(token: string, file: File, kind?: string): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  if (kind !== undefined) form.set("kind", kind);
  return routeMod.POST(
    new Request(`http://localhost/api/photo-drops/${token}`, { method: "POST", body: form }),
    { params: Promise.resolve({ token }) },
  );
}

function get(token: string): Promise<Response> {
  return routeMod.GET(new Request(`http://localhost/api/photo-drops/${token}`), {
    params: Promise.resolve({ token }),
  });
}

function png(name = "cigar.png"): File {
  return new File([PNG_1X1], name, { type: "image/png" });
}

async function codeOf(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

let routeMod: typeof import("./route");

describe("/api/photo-drops/[token]", () => {
  let h: DomainHarness;
  let dbmod: typeof import("@cj/db");
  let user: Principal;
  let token: string;
  let photoDropId: string;

  beforeAll(async () => {
    h = await createHarness();
    // The route talks to @cj/db's ambient client, which wires from the
    // environment at first use — so the env is set before the dynamic import.
    process.env.DATABASE_URL = h.pg.url;
    process.env.BETTER_AUTH_URL = "https://cigars.example.com";
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";

    routeMod = await import("./route");
    dbmod = await import("@cj/db");
  }, 60_000);

  afterAll(async () => {
    await (dbmod.db as unknown as { $client: { end: () => Promise<void> } }).$client
      .end()
      .catch(() => {});
    await h?.stop();
  });

  beforeEach(async () => {
    // A user per test, because there is ONE open drop per user (ADR-014): a
    // shared account would hand every test the same drop and the same photos.
    h.setNow(new Date());
    user = await h.createUser(`drop-route-${newRequestId()}@example.com`);
    const opened = await openPhotoDrop(h.deps, createMemoryPhotoStorage(), user);
    token = opened.token;
    photoDropId = opened.photoDropId;
  });

  it("reads a fresh drop as open, with nothing in it", async () => {
    const res = await get(token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StateBody;
    expect(body.photoDropId).toBe(photoDropId);
    expect(body.status).toBe("open");
    expect(body.smokeId).toBeNull();
    expect(body.photos).toEqual([]);
  });

  it("stages a photo and the state lists it", async () => {
    const res = await post(token, png(), "band");
    expect(res.status).toBe(201);
    const photo = (await res.json()) as PhotoBody;
    expect(photo.kind).toBe("band");
    // Staged, not on a smoke — there is no smoke yet, which is the whole point.
    expect(photo.attached).toBe(false);

    const state = (await (await get(token)).json()) as StateBody;
    expect(state.photos.map((p) => p.photoId)).toEqual([photo.photoId]);
  });

  it("a rejected file never counts against the drop, and the link keeps working", async () => {
    const rejected: [Response, string][] = [
      [
        await routeMod.POST(
          new Request(`http://localhost/api/photo-drops/${token}`, {
            method: "POST",
            body: new FormData(),
          }),
          { params: Promise.resolve({ token }) },
        ),
        "validation_error",
      ],
      [
        await post(
          token,
          new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "huge.jpg", { type: "image/jpeg" }),
        ),
        "too_large",
      ],
      [
        await post(
          token,
          new File([Buffer.from("%PDF-1.4")], "receipt.pdf", { type: "application/pdf" }),
        ),
        "unsupported_type",
      ],
      [
        await post(
          token,
          new File([Buffer.from("not an image at all")], "x.jpg", { type: "image/jpeg" }),
        ),
        "unreadable",
      ],
    ];
    const statuses = [400, 413, 415, 422];

    for (const [i, [res, code]] of rejected.entries()) {
      expect(res.status).toBe(statuses[i]);
      expect(await codeOf(res)).toBe(code);
    }

    // Nothing was staged, and the drop is still usable — the checks that reject a
    // file all run BEFORE anything the drop can spend.
    expect(((await (await get(token)).json()) as StateBody).photos).toEqual([]);
    expect((await post(token, png())).status).toBe(201);
  });

  it("refuses a kind the column would otherwise take", async () => {
    const res = await post(token, png(), "portrait");
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("validation_error");
  });

  it("reports the photo limit with the ceiling the page states back", async () => {
    for (let i = 0; i < MAX_PHOTOS_PER_DROP; i++) {
      expect((await post(token, png(`p${i}.png`))).status).toBe(201);
    }

    const overflow = await post(token, png("13.png"));
    expect(overflow.status).toBe(409);
    const body = (await overflow.json()) as { error: { code: string; limit: number } };
    expect(body.error.code).toBe("photo_limit");
    expect(body.error.limit).toBe(MAX_PHOTOS_PER_DROP);
  });

  it("after a claim the drop reads attached and a further photo lands on the smoke", async () => {
    const staged = (await (await post(token, png())).json()) as PhotoBody;

    const cigarId = await h.seedCigar({ canonicalName: `Drop Route ${newRequestId()}` });
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
    });
    const claim = await claimPhotoDrop(h.deps, user, {
      photoDropId,
      smokeId: saved.smoke.smokeId,
    });
    expect(claim.status).toBe("claimed");
    expect(claim.attached).toBe(1);

    const state = (await (await get(token)).json()) as StateBody;
    expect(state.status).toBe("attached");
    expect(state.smokeId).toBe(saved.smoke.smokeId);
    // The staged photo moved across keeping its id, so the page the user still
    // has open shows the same row.
    expect(state.photos.map((p) => p.photoId)).toEqual([staged.photoId]);
    expect(state.photos[0]!.attached).toBe(true);

    // The link outlives the claim: a photo taken after the save goes straight
    // onto the smoke rather than being staged for a claim that already happened.
    const later = (await (await post(token, png("later.png"))).json()) as PhotoBody;
    expect(later.attached).toBe(true);
  });

  it("answers an expired link 410 on both the read and the upload", async () => {
    // The route runs on the real clock, so the drop is minted with the harness
    // clock in the past and its 48 hours are long gone by the time it is used.
    const stale = await h.createUser(`drop-stale-${newRequestId()}@example.com`);
    h.setNow(new Date("2020-01-01T00:00:00.000Z"));
    const expired = await openPhotoDrop(h.deps, createMemoryPhotoStorage(), stale);
    h.setNow(new Date());

    const read = await get(expired.token);
    expect(read.status).toBe(410);
    expect(await codeOf(read)).toBe("upload_token_invalid");

    const upload = await post(expired.token, png());
    expect(upload.status).toBe(410);
    expect(await codeOf(upload)).toBe("upload_token_invalid");
  });

  it("answers an unknown token 410 on both, with no oracle", async () => {
    const read = await get("not-a-real-token");
    expect(read.status).toBe(410);
    expect(await codeOf(read)).toBe("upload_token_invalid");

    const upload = await post("not-a-real-token", png());
    expect(upload.status).toBe(410);
    expect(await codeOf(upload)).toBe("upload_token_invalid");
  });
});

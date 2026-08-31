import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHarness, newRequestId, type DomainHarness } from "@cj/domain/testing";
import { mintPhotoUploadToken, saveSmoke, MAX_PHOTOS_PER_SMOKE, type Principal } from "@cj/domain";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-limits";

// The upload link is the photo flow, so this route's ORDER is the thing under
// test. It used to consume the single-use token before looking at the file, so
// every 400/413/415/422 spent the link: the user picked the wrong file, fixed it,
// and was told the link had expired. It had not — the first attempt had burned
// it. These tests pin the fix from the outside: a rejected file must leave the
// link usable, and a genuinely dead link must still be refused.
//
// Object storage is swapped for the in-memory implementation because the retry
// has to SUCCEED to prove anything; the factory takes the real byte ceiling so
// the 413 boundary here is the shipped one.
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

function post(token: string, file: File): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  return routeMod.POST(new Request(`http://localhost/api/photo-uploads/${token}`, {
    method: "POST",
    body: form,
  }), { params: Promise.resolve({ token }) });
}

async function codeOf(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

let routeMod: typeof import("./route");

describe("POST /api/photo-uploads/[token]", () => {
  let h: DomainHarness;
  let dbmod: typeof import("@cj/db");
  let user: Principal;
  let smokeId: string;

  beforeAll(async () => {
    h = await createHarness();
    // The route talks to @cj/db's ambient client, which wires from the
    // environment at first use — so the env is set before the dynamic import.
    process.env.DATABASE_URL = h.pg.url;
    process.env.BETTER_AUTH_URL = "https://cigars.example.com";
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";

    routeMod = await import("./route");
    dbmod = await import("@cj/db");

    user = await h.createUser("upload-route@example.com");
  }, 60_000);

  afterAll(async () => {
    await (dbmod.db as unknown as { $client: { end: () => Promise<void> } }).$client
      .end()
      .catch(() => {});
    await h?.stop();
  });

  beforeEach(async () => {
    // Tokens are checked against the real clock inside the route, so the harness
    // clock tracks it; the expiry test moves it deliberately.
    h.setNow(new Date());
    const cigarId = await h.seedCigar({ canonicalName: `Upload Route ${newRequestId()}` });
    const saved = await saveSmoke(h.deps, user, {
      clientRequestId: newRequestId(),
      cigar: { cigarId },
      overallDescriptors: ["cedar"],
    });
    smokeId = saved.smoke.smokeId;
  });

  it("does not burn the link on an oversized file: the retry on the SAME token succeeds", async () => {
    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId, kind: "band" });

    const tooBig = await post(
      token,
      new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "huge.jpg", { type: "image/jpeg" }),
    );
    expect(tooBig.status).toBe(413);
    const code = await codeOf(tooBig);

    // The whole point, and asserted before the error code so a regression in the
    // ORDER fails here rather than hiding behind a copy assertion.
    const retry = await post(token, new File([PNG_1X1], "band.png", { type: "image/png" }));
    expect(retry.status).toBe(201);
    const view = (await retry.json()) as { smokeId: string; kind: string };
    expect(view.smokeId).toBe(smokeId);
    expect(view.kind).toBe("band");

    expect(code).toBe("too_large");
  });

  it("does not burn the link on an unsupported file type either", async () => {
    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });

    const wrongType = await post(
      token,
      new File([Buffer.from("%PDF-1.4")], "receipt.pdf", { type: "application/pdf" }),
    );
    expect(wrongType.status).toBe(415);
    const code = await codeOf(wrongType);

    const retry = await post(token, new File([PNG_1X1], "cigar.png", { type: "image/png" }));
    expect(retry.status).toBe(201);
    expect(code).toBe("unsupported_type");
  });

  it("does not burn the link when the bytes will not decode", async () => {
    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });

    const garbage = await post(
      token,
      new File([Buffer.from("not an image at all")], "x.jpg", { type: "image/jpeg" }),
    );
    expect(garbage.status).toBe(422);
    const code = await codeOf(garbage);

    const retry = await post(token, new File([PNG_1X1], "cigar.png", { type: "image/png" }));
    expect(retry.status).toBe(201);
    expect(code).toBe("unreadable");
  });

  it("does not burn the link when no file was sent", async () => {
    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });

    const empty = await routeMod.POST(
      new Request(`http://localhost/api/photo-uploads/${token}`, {
        method: "POST",
        body: new FormData(),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(empty.status).toBe(400);
    const code = await codeOf(empty);

    const retry = await post(token, new File([PNG_1X1], "cigar.png", { type: "image/png" }));
    expect(retry.status).toBe(201);
    expect(code).toBe("validation_error");
  });

  it("still refuses an expired token, with the code the page reads as expired", async () => {
    // Minted far enough in the past that even a 24h TTL is long gone by real now.
    h.setNow(new Date("2020-01-01T00:00:00.000Z"));
    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });

    const res = await post(token, new File([PNG_1X1], "cigar.png", { type: "image/png" }));
    expect(res.status).toBe(410);
    expect(await codeOf(res)).toBe("upload_token_invalid");
  });

  it("still refuses a token that was already spent on a successful upload", async () => {
    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });

    const first = await post(token, new File([PNG_1X1], "cigar.png", { type: "image/png" }));
    expect(first.status).toBe(201);

    const second = await post(token, new File([PNG_1X1], "cigar.png", { type: "image/png" }));
    expect(second.status).toBe(410);
    expect(await codeOf(second)).toBe("upload_token_invalid");
  });

  it("reports the photo limit with the count, which is what the page states back", async () => {
    // The one rejection that legitimately spends the link: it is the WRITE
    // failing, not the file being wrong. The payload carries `limit`, so the
    // page quotes the real ceiling instead of a number typed into the client.
    for (let i = 0; i < MAX_PHOTOS_PER_SMOKE; i++) {
      const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });
      const res = await post(token, new File([PNG_1X1], `p${i}.png`, { type: "image/png" }));
      expect(res.status).toBe(201);
    }

    const { token } = await mintPhotoUploadToken(h.deps, user, { smokeId });
    const overflow = await post(token, new File([PNG_1X1], "13.png", { type: "image/png" }));
    expect(overflow.status).toBe(409);
    const body = (await overflow.json()) as { error: { code: string; limit: number } };
    expect(body.error.code).toBe("photo_limit");
    expect(body.error.limit).toBe(MAX_PHOTOS_PER_SMOKE);
  });

  it("refuses an unknown token", async () => {
    const res = await post("not-a-real-token", new File([PNG_1X1], "c.png", { type: "image/png" }));
    expect(res.status).toBe(410);
    expect(await codeOf(res)).toBe("upload_token_invalid");
  });
});

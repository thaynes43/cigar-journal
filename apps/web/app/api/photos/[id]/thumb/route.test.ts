import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";

// The thumb route mirrors the full-size one and must answer identically: a
// malformed id is a 404 with the photo cache scope, never the 500 Postgres 22P02
// used to produce. Tested separately because the two routes are copies — a fix
// applied to one and not the other is exactly the drift worth pinning.
//
// Env precedes the import for the same reason as the full-size route's test: the
// db client, auth and photo storage are wired from process.env at first use, and
// the dummy S3 values only get the route past its "photos not enabled" 503.

describe("GET /api/photos/[id]/thumb", () => {
  let pg: TestPostgres;
  let route: typeof import("./route");
  let dbmod: typeof import("@cj/db");

  beforeAll(async () => {
    pg = await startTestPostgres();
    process.env.DATABASE_URL = pg.url;
    process.env.BETTER_AUTH_URL = "https://cigars.example.com";
    process.env.BETTER_AUTH_SECRET = "test-secret-value-that-is-plenty-long-1234567890";
    process.env.PHOTOS_S3_ENDPOINT = "https://rgw.invalid";
    process.env.PHOTOS_S3_BUCKET = "photos";
    process.env.PHOTOS_S3_ACCESS_KEY_ID = "test-access-key";
    process.env.PHOTOS_S3_SECRET_ACCESS_KEY = "test-secret-key";

    route = await import("./route");
    dbmod = await import("@cj/db");
  }, 60_000);

  afterAll(async () => {
    // The route's session lookup opens the ambient pool; close it before the
    // server goes away or the dying connection surfaces as an uncaught 57P01.
    await (dbmod.db as unknown as { $client: { end: () => Promise<void> } }).$client
      .end()
      .catch(() => {});
    await pg?.stop();
  });

  it("answers 404, not 500, for a malformed id", async () => {
    const res = await route.GET(new Request("http://localhost/api/photos/not-a-uuid/thumb"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("answers 404 for a well-formed but unknown id", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const res = await route.GET(new Request(`http://localhost/api/photos/${id}/thumb`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Vary")).toBe("Cookie");
  });
});

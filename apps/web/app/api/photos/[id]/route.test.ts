import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestPostgres, type TestPostgres } from "@cj/db/testing";

// HTTP-adapter test for the full-size smoke-photo route: a malformed id in the
// URL must be answered, not crashed on. It used to reach a uuid column and raise
// Postgres 22P02 — untyped, so it surfaced as a 500 on a public URL. The shape
// guard now throws PhotoNotFoundError before any query, which is why this path
// is reachable with no object storage behind it.
//
// Env is set before importing the route: @cj/db's client, the auth singleton and
// the photo storage are all wired at first use from process.env. The S3 values
// are dummies only so `photoStorage` is non-null and the route gets past its 503
// guard; nothing on this path contacts the endpoint.

describe("GET /api/photos/[id]", () => {
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
    const res = await route.GET(new Request("http://localhost/api/photos/not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(404);
    // The error response is cacheable too, so it carries the same cache scope as
    // the bytes it stands in for.
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  it("answers 404 for a well-formed but unknown id", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const res = await route.GET(new Request(`http://localhost/api/photos/${id}`), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Vary")).toBe("Cookie");
  });
});

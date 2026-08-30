import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";

// Migrations apply cleanly from empty against a real Postgres 16 (embedded
// binary). Also asserts idempotency and that the core extensions/objects land.
describe("migrations", () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it("creates the core tables and extensions", async () => {
    const tables = await pg.db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "audit_log",
        "brand_images",
        "cigar_merges",
        "cigars",
        "duplicate_dismissals",
        "favorites",
        "idempotency_keys",
        "invites",
        "listing_matches",
        "offers",
        "photo_upload_tokens",
        "purchases",
        "wants",
        "schema_migrations",
        "crawl_runs",
        "enrichment_attempts",
        "enrichment_requests",
        "product_photos",
        "smoke_consumptions",
        "smoke_photos",
        "smoke_progression",
        "smokes",
        "users",
        "vendors",
      ]),
    );

    const ext = await pg.db.execute(sql`SELECT extname FROM pg_extension ORDER BY extname`);
    const extnames = ext.rows.map((r) => r.extname);
    expect(extnames).toEqual(expect.arrayContaining(["citext", "pg_trgm"]));
  });

  it("is idempotent — re-running applies nothing", async () => {
    const result = await migrate(pg.url);
    expect(result.applied).toEqual([]);
  });

  // 0023: the per-vendor enrichment ledger (#158). Every assertion here is a
  // constraint the rollup relies on — one row per (ask, vendor) as the atomic
  // ON CONFLICT target, and cascades on both parents so a verdict can never
  // outlive the thing it names.
  it("0023 enforces one attempt row per (request, vendor) and cascades from both parents", async () => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Ledger Constraint Subject') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const request = await pg.db.execute(
      sql`INSERT INTO enrichment_requests (cigar_id) VALUES (${cigarId}) RETURNING id`,
    );
    const requestId = (request.rows[0] as { id: string }).id;
    const vendor = await pg.db.execute(
      sql`INSERT INTO vendors (name, focus) VALUES ('Ledger Vendor', 'NC') RETURNING id`,
    );
    const vendorId = (vendor.rows[0] as { id: string }).id;

    const attempt = () =>
      pg.db.execute(sql`
        INSERT INTO enrichment_attempts (request_id, vendor_id, last_outcome)
        VALUES (${requestId}, ${vendorId}, 'miss')
      `);
    await attempt();
    await expect(attempt()).rejects.toThrow();

    // A negative counter is unrepresentable — the rollup reads these as budgets.
    await expect(
      pg.db.execute(sql`UPDATE enrichment_attempts SET attempts = -1 WHERE request_id = ${requestId}`),
    ).rejects.toThrow();
    await expect(
      pg.db.execute(sql`
        INSERT INTO enrichment_attempts (request_id, vendor_id, last_outcome)
        VALUES (${requestId}, ${vendorId}, 'gave-up')
      `),
    ).rejects.toThrow();

    // Deleting the ask takes its evidence with it.
    await pg.db.execute(sql`DELETE FROM enrichment_requests WHERE id = ${requestId}`);
    const afterRequest = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM enrichment_attempts WHERE request_id = ${requestId}`,
    );
    expect((afterRequest.rows[0] as { n: number }).n).toBe(0);

    // And deleting the vendor does too: a verdict naming a vendor that no longer
    // exists is worse than no verdict, and it reopens the request, which is honest.
    const second = await pg.db.execute(
      sql`INSERT INTO enrichment_requests (cigar_id) VALUES (${cigarId}) RETURNING id`,
    );
    const secondId = (second.rows[0] as { id: string }).id;
    await pg.db.execute(sql`
      INSERT INTO enrichment_attempts (request_id, vendor_id, last_outcome)
      VALUES (${secondId}, ${vendorId}, 'miss')
    `);
    await pg.db.execute(sql`DELETE FROM vendors WHERE id = ${vendorId}`);
    const afterVendor = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM enrichment_attempts WHERE request_id = ${secondId}`,
    );
    expect((afterVendor.rows[0] as { n: number }).n).toBe(0);
  });

  // The 0023 backfill claims exactly one thing and no more: the drain stopped
  // writing `in_progress`, so a legacy row in that state would be unreachable.
  // It deliberately does NOT split the old vendor-blind `attempts` across vendors —
  // that would mean inventing which vendor spent it.
  it("0023 normalizes legacy in_progress rows to pending and leaves attempts alone", async () => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Legacy In Progress') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const request = await pg.db.execute(sql`
      INSERT INTO enrichment_requests (cigar_id, status, attempts)
      VALUES (${cigarId}, 'in_progress', 1) RETURNING id
    `);
    const requestId = (request.rows[0] as { id: string }).id;

    // The migration body, replayed against the row it was written for.
    await pg.db.execute(sql`UPDATE enrichment_requests SET status = 'pending' WHERE status = 'in_progress'`);

    const after = await pg.db.execute(
      sql`SELECT status, attempts FROM enrichment_requests WHERE id = ${requestId}`,
    );
    expect(after.rows[0]).toMatchObject({ status: "pending", attempts: 1 });
    // The ledger stays empty: every (request, vendor) pair starts at zero.
    const ledger = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM enrichment_attempts WHERE request_id = ${requestId}`,
    );
    expect((ledger.rows[0] as { n: number }).n).toBe(0);
  });

  // 0022: the partial unique index is what keeps /settings from listing rival
  // links for one address. It must bind only OPEN invites, so a redeemed or
  // revoked one frees the address again.
  it("0022 permits one open invite per address, and a fresh one once it is spent", async () => {
    const owner = await pg.db.execute(
      sql`INSERT INTO users (email) VALUES ('invite-index@example.com') RETURNING id`,
    );
    const ownerId = (owner.rows[0] as { id: string }).id;
    const insert = (hash: string) => pg.db.execute(
      sql`INSERT INTO invites (token_hash, email, invited_by, expires_at)
          VALUES (${hash}, 'target@example.com', ${ownerId}::uuid, now() + interval '7 days')
          RETURNING id`,
    );

    const first = await insert("hash-one");
    await expect(insert("hash-two")).rejects.toThrow();

    const firstId = (first.rows[0] as { id: string }).id;
    await pg.db.execute(sql`UPDATE invites SET revoked_at = now() WHERE id = ${firstId}::uuid`);
    const second = await insert("hash-three");
    const secondId = (second.rows[0] as { id: string }).id;

    await pg.db.execute(sql`UPDATE invites SET redeemed_at = now() WHERE id = ${secondId}::uuid`);
    await expect(insert("hash-four")).resolves.toBeDefined();
  });

  // The brand_images rights model is enforced by shape (0019): a Wikimedia image
  // may not be stored without the attribution the UI is obliged to render with
  // it. A row carrying object_key but no source_url/license_name must not exist.
  it("brand_images rejects stored bytes without their attribution", async () => {
    const insert = (columns: string, values: string) =>
      pg.db.execute(sql.raw(`INSERT INTO brand_images (${columns}) VALUES (${values})`));

    // Drizzle wraps the driver error, so the constraint name rides the cause.
    const rejected = await insert(
      "brand_slug, brand_name, status, object_key, thumb_key, content_type",
      "'gate-a', 'Gate A', 'resolved', 'brand/gate-a/1.jpg', 'brand/gate-a/1.thumb.jpg', 'image/jpeg'",
    ).catch((e: unknown) => e);
    expect((rejected as { cause?: { constraint?: string } })?.cause?.constraint).toBe(
      "brand_images_servable_complete",
    );

    // Same row plus the credit columns is accepted.
    await insert(
      "brand_slug, brand_name, status, object_key, thumb_key, content_type, source_url, license_name",
      "'gate-b', 'Gate B', 'resolved', 'brand/gate-b/1.jpg', 'brand/gate-b/1.thumb.jpg', 'image/jpeg', " +
        "'https://commons.wikimedia.org/wiki/File:B.jpg', 'CC BY-SA 4.0'",
    );

    // And an outcome-only row (no bytes) is unconstrained — the negative cache.
    await insert("brand_slug, brand_name, status", "'gate-c', 'Gate C', 'no_match'");
  });
});

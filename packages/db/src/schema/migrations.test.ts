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
        "blend_blenders",
        "blenders",
        "blends",
        "brand_images",
        "brands",
        "cigar_merges",
        "cigars",
        "lines",
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

  // 0026: the taxonomy registries (ADR-012). These are the shapes the rest of
  // the waves build on — slug uniqueness at the right scope, and a leaf that
  // survives its registry.
  it("0026 scopes slug uniqueness per parent and keeps blend credit a set", async () => {
    const brandA = await pg.db.execute(
      sql`INSERT INTO brands (name, slug) VALUES ('Taxonomy Brand A', 'taxonomy-brand-a') RETURNING id`,
    );
    const brandAId = (brandA.rows[0] as { id: string }).id;
    const brandB = await pg.db.execute(
      sql`INSERT INTO brands (name, slug) VALUES ('Taxonomy Brand B', 'taxonomy-brand-b') RETURNING id`,
    );
    const brandBId = (brandB.rows[0] as { id: string }).id;

    // A brand slug is global — it is the URL key.
    await expect(
      pg.db.execute(sql`INSERT INTO brands (name, slug) VALUES ('Clash', 'taxonomy-brand-a')`),
    ).rejects.toThrow();

    // A line slug is unique WITHIN a brand only: two brands may each have a
    // `reserva` and neither has to yield the name.
    const line = await pg.db.execute(
      sql`INSERT INTO lines (brand_id, name, slug) VALUES (${brandAId}, 'Reserva', 'reserva') RETURNING id`,
    );
    const lineId = (line.rows[0] as { id: string }).id;
    await expect(
      pg.db.execute(sql`INSERT INTO lines (brand_id, name, slug) VALUES (${brandBId}, 'Reserva', 'reserva')`),
    ).resolves.toBeDefined();
    await expect(
      pg.db.execute(sql`INSERT INTO lines (brand_id, name, slug) VALUES (${brandAId}, 'Reserva', 'reserva')`),
    ).rejects.toThrow();

    // Same rule one level down, scoped to the line.
    const blend = await pg.db.execute(
      sql`INSERT INTO blends (line_id, name, slug) VALUES (${lineId}, 'No. 9', 'no-9') RETURNING id`,
    );
    const blendId = (blend.rows[0] as { id: string }).id;
    await expect(
      pg.db.execute(sql`INSERT INTO blends (line_id, name, slug) VALUES (${lineId}, 'No. 9', 'no-9')`),
    ).rejects.toThrow();

    // Credit is a set: one blender cannot be credited twice on one blend.
    const blender = await pg.db.execute(
      sql`INSERT INTO blenders (name, slug) VALUES ('Taxonomy Blender', 'taxonomy-blender') RETURNING id`,
    );
    const blenderId = (blender.rows[0] as { id: string }).id;
    const credit = () =>
      pg.db.execute(
        sql`INSERT INTO blend_blenders (blend_id, blender_id) VALUES (${blendId}, ${blenderId})`,
      );
    await credit();
    await expect(credit()).rejects.toThrow();
  });

  // Retiring a registry row must never delete a cigar — and therefore never a
  // smoke, a purchase, or anything else hanging off the leaf. The ancestry FKs
  // null out; the registry's own hierarchy cascades.
  it("0026 nulls a cigar's ancestry when a registry row is deleted, never the cigar", async () => {
    const brand = await pg.db.execute(
      sql`INSERT INTO brands (name, slug) VALUES ('Doomed Brand', 'doomed-brand') RETURNING id`,
    );
    const brandId = (brand.rows[0] as { id: string }).id;
    const line = await pg.db.execute(
      sql`INSERT INTO lines (brand_id, name, slug) VALUES (${brandId}, 'Doomed Line', 'doomed-line') RETURNING id`,
    );
    const lineId = (line.rows[0] as { id: string }).id;
    const blend = await pg.db.execute(
      sql`INSERT INTO blends (line_id, name, slug) VALUES (${lineId}, 'Doomed Blend', 'doomed-blend') RETURNING id`,
    );
    const blendId = (blend.rows[0] as { id: string }).id;
    const cigar = await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, brand_id, line_id, blend_id)
      VALUES ('Doomed Ancestry Subject', ${brandId}, ${lineId}, ${blendId}) RETURNING id
    `);
    const cigarId = (cigar.rows[0] as { id: string }).id;

    // Deleting the brand cascades through line and blend (a line cannot outlive
    // its brand) while the cigar survives with a fully null ancestry.
    await pg.db.execute(sql`DELETE FROM brands WHERE id = ${brandId}`);
    const after = await pg.db.execute(
      sql`SELECT brand_id, line_id, blend_id FROM cigars WHERE id = ${cigarId}`,
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ brand_id: null, line_id: null, blend_id: null });

    const orphans = await pg.db.execute(sql`
      SELECT (SELECT count(*)::int FROM lines WHERE id = ${lineId}) AS lines,
             (SELECT count(*)::int FROM blends WHERE id = ${blendId}) AS blends
    `);
    expect(orphans.rows[0]).toMatchObject({ lines: 0, blends: 0 });
  });

  // `name_source` is the switch Wave 2 flips to make canonical_name a
  // projection. Only the two states exist, and every existing row is freeform.
  it("0026 defaults name_source to freeform and admits no third state", async () => {
    const row = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Name Source Default') RETURNING name_source`,
    );
    expect((row.rows[0] as { name_source: string }).name_source).toBe("freeform");

    await expect(
      pg.db.execute(
        sql`INSERT INTO cigars (canonical_name, name_source) VALUES ('Bad Source', 'derived')`,
      ),
    ).rejects.toThrow();
    await expect(
      pg.db.execute(
        sql`INSERT INTO cigars (canonical_name, name_source) VALUES ('Composed Row', 'composed')`,
      ),
    ).resolves.toBeDefined();
  });
});

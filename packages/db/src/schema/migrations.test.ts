import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";
import { vendors } from "./vendors.js";
import { cigars } from "./cigars.js";
import { productPhotos } from "./product-photos.js";
import { listingMatches } from "./listing-matches.js";

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

  // 0025: two read-path indexes and one registry correction, no schema change.
  // They are not an optimization detail — the evidenced market (#170) is a
  // correlated subquery keyed on `listing_matches.cigar_id`, a column that carried
  // NO index at all, evaluated twice per row in the crawler's open set and once per
  // row for up to ENRICHMENT_BACKLOG_MAX = 100 rows a backlog press.
  it("0025 creates the evidenced-market and lane-liveness indexes", async () => {
    const rows = await pg.db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('listing_matches_cigar_idx', 'crawl_runs_vendor_kind_started_idx')
      ORDER BY indexname
    `);
    const byName = new Map((rows.rows as { indexname: string; indexdef: string }[]).map((r) => [r.indexname, r.indexdef]));

    // Partial on NOT NULL: an unmatched listing is evidence about no cigar, and
    // most of the triage queue is unmatched.
    expect(byName.get("listing_matches_cigar_idx")).toMatch(/cigar_id IS NOT NULL/);
    // Column order follows the equality predicates the two readers share, with
    // started_at trailing so the liveness read is a backwards scan for its max.
    expect(byName.get("crawl_runs_vendor_kind_started_idx")).toMatch(
      /\(vendor_id, kind, status, started_at DESC\)/,
    );
  });

  // The registry correction (#170). Asserted on a row this test inserts rather
  // than on the migration's own effect, because the test database starts empty:
  // what is pinned is that the UPDATE is idempotent, correctly targeted, and
  // guarded — re-running it must not touch a vendor someone has since re-decided.
  it("0025's vendor correction retargets only a still-CC Cuban Lou's", async () => {
    const stmt = sql`UPDATE vendors SET focus = 'both' WHERE name = 'Cuban Lou''s' AND focus = 'CC'`;

    const [stale, alreadyFixed, redecided, other] = await Promise.all([
      pg.db.insert(vendors).values({ name: "Cuban Lou's", focus: "CC" }).returning({ id: vendors.id }),
      pg.db.insert(vendors).values({ name: "Cuban Lou's", focus: "both" }).returning({ id: vendors.id }),
      pg.db.insert(vendors).values({ name: "Cuban Lou's", focus: "NC" }).returning({ id: vendors.id }),
      pg.db.insert(vendors).values({ name: "Fox Cigar", focus: "NC" }).returning({ id: vendors.id }),
    ]);

    await pg.db.execute(stmt);
    // Idempotent: the second run is a no-op, not a second correction.
    await pg.db.execute(stmt);

    const focusOf = async (id: string) =>
      (await pg.db.select({ focus: vendors.focus }).from(vendors).where(eq(vendors.id, id)))[0]?.focus;

    expect(await focusOf(stale[0]!.id)).toBe("both");
    expect(await focusOf(alreadyFixed[0]!.id)).toBe("both");
    // Guarded on focus='CC', so a later deliberate decision is not silently undone.
    expect(await focusOf(redecided[0]!.id)).toBe("NC");
    // And no other vendor is in range of the name predicate.
    expect(await focusOf(other[0]!.id)).toBe("NC");
  });

  // The artifact half of 0025 (#170). The guard rides on `source_url` and not on
  // the cigar id, because the source URL is the EVIDENCE: it names foxcigar.com and
  // it names the 1875 Petit Bully, so the predicate asserts the very thing that
  // makes the photo wrong. A hand-copied id would delete whatever occupies the slot
  // at deploy time — including a correct photo a curator uploaded in the meantime,
  // which is the one outcome worse than leaving the bad one.
  const FOX_RYJ_IMG =
    "https://foxcigar.com/wp-content/uploads/2026/04/fox-product-romeo-y-julieta-1875-petit-bully-1000034200-0-1.jpg";

  it("0025 deletes only the wrong-market Romeo y Julieta photo", async () => {
    const stmt = sql`
      DELETE FROM product_photos pp USING cigars c
       WHERE c.id = pp.cigar_id
         AND c.canonical_name = 'Petit Royales Romeo y Julieta'
         AND pp.source_url = ${FOX_RYJ_IMG}
    `;
    const photo = async (cigarId: string, sourceUrl: string, tag: string) => {
      await pg.db.insert(productPhotos).values({
        cigarId,
        sourceUrl,
        objectKey: `obj/${tag}`,
        thumbKey: `thumb/${tag}`,
        contentType: "image/jpeg",
        width: 800,
        height: 600,
        bytes: 1234,
      });
    };
    const seed = async (name: string) =>
      (await pg.db.insert(cigars).values({ canonicalName: name }).returning({ id: cigars.id }))[0]!.id;

    const target = await seed("Petit Royales Romeo y Julieta");
    // Same cigar, a photo somebody else supplied: the delete must not reach it.
    const replaced = await seed("Petit Royales Romeo y Julieta");
    // Same wrong source, a different cigar: nor this one.
    const elsewhere = await seed("Romeo y Julieta 1875 Petit Bully");

    await photo(target, FOX_RYJ_IMG, "target");
    await photo(replaced, "https://curator.example/uploaded.jpg", "replaced");
    await photo(elsewhere, FOX_RYJ_IMG, "elsewhere");

    await pg.db.execute(stmt);
    // Idempotent: a re-run finds nothing left to delete.
    await pg.db.execute(stmt);

    const remaining = async (cigarId: string) =>
      (await pg.db.select().from(productPhotos).where(eq(productPhotos.cigarId, cigarId))).length;
    expect(await remaining(target)).toBe(0);
    expect(await remaining(replaced)).toBe(1);
    expect(await remaining(elsewhere)).toBe(1);
  });

  // 0026: the two columns that make a crawler refusal legible. Both replace a state
  // in which a refusal was byte-identical to an ordinary negative.
  it("0026 admits the crawler's unmatched reasons and rejects anything else", async () => {
    const [vendor] = await pg.db.insert(vendors).values({ name: "Reason Vendor" }).returning({ id: vendors.id });
    const insert = (reason: string | null) =>
      pg.db.insert(listingMatches).values({
        vendorId: vendor!.id,
        listingKey: `reason-${reason ?? "null"}-${Math.random()}`,
        status: "unmatched",
        unmatchedReason: reason as "market_refusal" | "no_match" | null,
      });

    await expect(insert("market_refusal")).resolves.toBeDefined();
    await expect(insert("no_match")).resolves.toBeDefined();
    // NULL is the third meaning — not the crawler's guess at all — and stays legal.
    await expect(insert(null)).resolves.toBeDefined();
    await expect(insert("because-i-said-so")).rejects.toThrow();
  });

  // The backfill, asserted on rows the test inserts (the test database starts
  // empty). It is what makes prod's 3 existing crawler-unmatched listings appear in
  // triage at deploy rather than after the next crawl rewrites them, and it must
  // reach nothing else — an agent's verdict is settled, and a cascade row has no
  // reason by construction.
  it("0026's backfill claims only crawler-decided unmatched rows", async () => {
    const stmt = sql`
      UPDATE listing_matches SET unmatched_reason = 'no_match'
       WHERE status = 'unmatched' AND decided_by = 'crawler' AND unmatched_reason IS NULL
    `;
    const [vendor] = await pg.db.insert(vendors).values({ name: "Backfill Vendor" }).returning({ id: vendors.id });
    const add = async (values: { status: "auto" | "unmatched"; decidedBy?: "crawler" | "curator" | "agent" }) =>
      (
        await pg.db
          .insert(listingMatches)
          .values({ vendorId: vendor!.id, listingKey: `bf-${Math.random()}`, ...values })
          .returning({ id: listingMatches.id })
      )[0]!.id;

    const crawlerUnmatched = await add({ status: "unmatched" });
    const agentUnmatched = await add({ status: "unmatched", decidedBy: "agent" });
    const crawlerAuto = await add({ status: "auto" });

    await pg.db.execute(stmt);
    await pg.db.execute(stmt); // idempotent — the guard is `IS NULL`

    const reasonOf = async (id: string) =>
      (await pg.db.select().from(listingMatches).where(eq(listingMatches.id, id)))[0]!.unmatchedReason;
    expect(await reasonOf(crawlerUnmatched)).toBe("no_match");
    expect(await reasonOf(agentUnmatched)).toBeNull();
    expect(await reasonOf(crawlerAuto)).toBeNull();
  });

  it("0026 admits photo_refused as an attempt outcome", async () => {
    const check = await pg.db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'enrichment_attempts'::regclass
         AND conname = 'enrichment_attempts_last_outcome_check'
    `);
    const def = (check.rows as { def: string }[])[0]?.def ?? "";
    // A refusal is a fourth verdict, not a re-labelled miss: it burns no attempt,
    // because `attempts` running out is what licenses "we read this catalogue and
    // the cigar is not in it" — which a refusal disproves.
    expect(def).toMatch(/photo_refused/);
    expect(def).toMatch(/miss/);
    expect(def).toMatch(/match/);
    expect(def).toMatch(/error/);
  });
});

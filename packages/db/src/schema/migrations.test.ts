import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { startTestPostgres, type TestPostgres } from "../testing/embedded-pg.js";
import { migrate } from "../scripts/migrate.js";
import { vendors } from "./vendors.js";
import { cigars } from "./cigars.js";
import { productPhotos } from "./product-photos.js";
import { offers } from "./offers.js";
import { listingMatches, type SuggestedParse } from "./listing-matches.js";

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
        "photo_drops",
        "photo_upload_tokens",
        "purchases",
        "staged_smoke_photos",
        "wants",
        "schema_migrations",
        "crawl_runs",
        "enrichment_attempts",
        "enrichment_requests",
        "product_photos",
        "review_observations",
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

  // 0034: the vendor tier (ADR-015). The CHECK is the point — a tier is an
  // ORDINAL an admin types, and a typo outside the band would silently sort a shop
  // to the front of the fleet, into the display gate and onto the photo slot.
  // 0036: both photo tables default `kind` to `cigar` (#287). Asserted on the
  // catalog rather than by inserting rows — the column is what the migration
  // changed, and a row would need a user, a smoke or a drop to hang off.
  it("0036 defaults both photo tables' kind to cigar and backfills nothing", async () => {
    const defaults = await pg.db.execute(
      sql`SELECT table_name, column_default
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name IN ('smoke_photos', 'staged_smoke_photos', 'photo_upload_tokens')
             AND column_name = 'kind'
           ORDER BY table_name`,
    );
    expect(defaults.rows).toEqual([
      // The single-use link keeps `other`: @cj/domain always writes this column
      // explicitly, so its default is unreachable from any shipped path.
      { table_name: "photo_upload_tokens", column_default: "'other'::text" },
      { table_name: "smoke_photos", column_default: "'cigar'::text" },
      { table_name: "staged_smoke_photos", column_default: "'cigar'::text" },
    ]);

    // The CHECK still admits every kind — a default is not a narrowing.
    const checks = await pg.db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def
            FROM pg_constraint
           WHERE conrelid = 'smoke_photos'::regclass AND contype = 'c'`,
    );
    expect(JSON.stringify(checks.rows)).toContain("'other'");
  });

  it("0034 defaults the tier to 2 and refuses one outside [1, 9]", async () => {
    const [defaulted] = await pg.db
      .insert(vendors)
      .values({ name: "Tier Default Shop" })
      .returning({ id: vendors.id, tier: vendors.tier });
    // Never 1: "nobody has decided" must not mean "price authority".
    expect(defaulted!.tier).toBe(2);

    await expect(pg.db.insert(vendors).values({ name: "Tier Zero", tier: 0 })).rejects.toThrow();
    await expect(pg.db.insert(vendors).values({ name: "Tier Ten", tier: 10 })).rejects.toThrow();
    await expect(pg.db.insert(vendors).values({ name: "Tier Top", tier: 1 })).resolves.toBeDefined();
    await expect(pg.db.insert(vendors).values({ name: "Tier Floor", tier: 9 })).resolves.toBeDefined();
  });

  // The backfill, asserted on rows this test inserts (the test database starts
  // empty), on the same terms as 0025's vendor correction: what is pinned is that
  // the UPDATE is idempotent, correctly targeted and GUARDED — re-running it must
  // not undo a tier someone has since re-decided.
  it("0034 promotes only the still-default tier-1 adapters' rows", async () => {
    const stmt = sql`UPDATE vendors SET tier = 1
                      WHERE name IN ('Fox Cigar', '2 Guys Cigars', 'Small Batch Cigar') AND tier = 2`;

    const [atDefault, redecided, other, dormant] = await Promise.all([
      pg.db.insert(vendors).values({ name: "Fox Cigar", tier: 2 }).returning({ id: vendors.id }),
      pg.db.insert(vendors).values({ name: "Fox Cigar", tier: 3 }).returning({ id: vendors.id }),
      pg.db.insert(vendors).values({ name: "Cuban Lou's", tier: 2 }).returning({ id: vendors.id }),
      // A tier-1 adapter whose lane is not enabled yet: the row is promoted all
      // the same, so a resolve reports no drift against the adapter.
      pg.db.insert(vendors).values({ name: "Small Batch Cigar", tier: 2 }).returning({ id: vendors.id }),
    ]);

    await pg.db.execute(stmt);
    // Idempotent: the second run is a no-op, not a second promotion.
    await pg.db.execute(stmt);

    const tierOf = async (id: string) =>
      (await pg.db.select({ tier: vendors.tier }).from(vendors).where(eq(vendors.id, id)))[0]?.tier;

    expect(await tierOf(atDefault[0]!.id)).toBe(1);
    // Guarded on tier = 2, so a deliberate later decision stands.
    expect(await tierOf(redecided[0]!.id)).toBe(3);
    // Cuban Lou's is unapproved: it stays at the default, recorded and not shown.
    expect(await tierOf(other[0]!.id)).toBe(2);
    expect(await tierOf(dormant[0]!.id)).toBe(1);
  });

  // 0035: a bare listing at a single-stick shop IS a single (DESIGN-005 amendment
  // 2026-09-02). Asserted on rows this test inserts, as 0034's is — the test
  // database starts empty, so the migration itself moved nothing. What is pinned
  // is the PREDICATE: who is in scope, who is out, and that the per-stick figure
  // is the one `computePricePerStickCents` would have written.
  it("0035 makes a bare Fox listing a single and leaves every stated packaging alone", async () => {
    const stmt = sql`UPDATE offers o
                        SET packaging = 'single',
                            sticks_per_package = 1,
                            price_per_stick_cents = round(o.price * 100)::int
                       FROM vendors v
                      WHERE v.id = o.vendor_id
                        AND v.name IN ('Fox Cigar', 'Cigarworld.de', 'J.J. Fox')
                        AND o.packaging IS NULL
                        AND o.sticks_per_package IS NULL
                        AND o.price IS NOT NULL`;

    const [fox] = await pg.db.insert(vendors).values({ name: "Fox Cigar", tier: 1 }).returning({ id: vendors.id });
    const [smallBatch] = await pg.db
      .insert(vendors)
      .values({ name: "Small Batch Cigar", tier: 1 })
      .returning({ id: vendors.id });

    const offer = async (vendorId: string, values: Partial<typeof offers.$inferInsert>) =>
      (await pg.db.insert(offers).values({ vendorId, currency: "USD", ...values }).returning({ id: offers.id }))[0]!.id;

    // The population: a name that states no packaging, at a shop that sells one
    // stick by default. 6,044 Fox rows looked like this on 2026-09-02.
    const bare = await offer(fox!.id, { price: "12.10", listingUrl: "https://foxcigar.com/shop/padron-torpedo/" });
    // Stated in the name — untouched, and the reason the predicate needs no
    // literal list of container words.
    const box = await offer(fox!.id, {
      price: "460.00",
      packaging: "box",
      sticksPerPackage: 20,
      pricePerStickCents: 2300,
    });
    // A count with no label (`Davidoff Premium Selection 12 Count`). Without the
    // `sticks_per_package IS NULL` guard this becomes a $312 SINGLE — DESIGN-005's
    // own defect, inverted — and the SQL would disagree with `packagingOf`, which
    // consults the vendor's posture only when neither a label nor a count exists.
    const counted = await offer(fox!.id, { price: "312.00", sticksPerPackage: 12, pricePerStickCents: 2600 });
    // A null price has no per-stick; the next crawl re-derives both facts.
    const priceless = await offer(fox!.id, { price: null });
    // A vendor that declares no posture: its bare listing genuinely states nothing.
    const grouped = await offer(smallBatch!.id, { price: "11.00" });

    await pg.db.execute(stmt);
    // Idempotent: the second run finds no `packaging IS NULL` row left in scope.
    await pg.db.execute(stmt);

    const facts = async (id: string) =>
      (
        await pg.db
          .select({
            packaging: offers.packaging,
            sticks: offers.sticksPerPackage,
            perStick: offers.pricePerStickCents,
          })
          .from(offers)
          .where(eq(offers.id, id))
      )[0]!;

    // Per-stick mirrors `computePricePerStickCents` at one stick: round(price*100).
    expect(await facts(bare)).toEqual({ packaging: "single", sticks: 1, perStick: 1210 });
    expect(await facts(box)).toEqual({ packaging: "box", sticks: 20, perStick: 2300 });
    expect(await facts(counted)).toEqual({ packaging: null, sticks: 12, perStick: 2600 });
    expect(await facts(priceless)).toEqual({ packaging: null, sticks: null, perStick: null });
    expect(await facts(grouped)).toEqual({ packaging: null, sticks: null, perStick: null });
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

  // 0025 parts 2 and 3: the two schema changes that make a crawler refusal
  // legible. Both replace a state
  // in which a refusal was byte-identical to an ordinary negative.
  it("0025 admits the crawler's unmatched reasons and rejects anything else", async () => {
    const [vendor] = await pg.db.insert(vendors).values({ name: "Reason Vendor" }).returning({ id: vendors.id });
    const insert = (reason: string | null) =>
      pg.db.insert(listingMatches).values({
        vendorId: vendor!.id,
        listingKey: `reason-${reason ?? "null"}-${Math.random()}`,
        status: "unmatched",
        // Cast so an arbitrary string reaches the insert and the DATABASE's CHECK
        // is what rejects it — the point of the test. Spelled with the full union
        // 0027 widened the column to, so this is the last place in the tree still
        // claiming the constraint admits two values.
        unmatchedReason: reason as "market_refusal" | "no_match" | "no_anchor" | "ambiguous" | null,
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
  it("0025's backfill claims only crawler-decided unmatched rows", async () => {
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

  it("0025 admits photo_refused as an attempt outcome", async () => {
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

  // Two different protections, and they point in opposite directions. Below the
  // registry, a cigar must survive its taxonomy being retired: the leaf FKs are
  // SET NULL, so a smoke or a purchase can never be deleted by a curation edit.
  // Inside the registry, a parent must NOT be retired while it still has
  // children: those FKs are NO ACTION, so an accidental DELETE is refused rather
  // than quietly taking a brand's whole line-and-blend tree with it.
  it("0026 refuses to delete a brand that still has lines, and nulls the leaf when it finally goes", async () => {
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

    // The hierarchy refuses. A brand with lines is not deletable, and neither is
    // a line that still has blends — retiring a marca is a curation decision, not
    // something one stray DELETE performs on the whole tree.
    await expect(pg.db.execute(sql`DELETE FROM brands WHERE id = ${brandId}`)).rejects.toThrow();
    await expect(pg.db.execute(sql`DELETE FROM lines WHERE id = ${lineId}`)).rejects.toThrow();

    // Unlinked from the bottom up, each delete now succeeds — and the cigar
    // survives every one of them, ending with a fully null ancestry rather than
    // being deleted along with the taxonomy that described it.
    await pg.db.execute(sql`DELETE FROM blends WHERE id = ${blendId}`);
    await pg.db.execute(sql`DELETE FROM lines WHERE id = ${lineId}`);
    await pg.db.execute(sql`DELETE FROM brands WHERE id = ${brandId}`);

    const after = await pg.db.execute(
      sql`SELECT brand_id, line_id, blend_id FROM cigars WHERE id = ${cigarId}`,
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({ brand_id: null, line_id: null, blend_id: null });
  });

  // Why NO ACTION and not RESTRICT: both refuse the accidental delete, but
  // RESTRICT is checked per row while NO ACTION is checked at the end of the
  // statement. Only NO ACTION lets a deliberate curation move retire a brand and
  // its lines together in one statement — the shape Wave 3 needs.
  it("0026 still allows a brand and its lines to be retired in a single statement", async () => {
    const brand = await pg.db.execute(
      sql`INSERT INTO brands (name, slug) VALUES ('Retired Brand', 'retired-brand') RETURNING id`,
    );
    const brandId = (brand.rows[0] as { id: string }).id;
    await pg.db.execute(
      sql`INSERT INTO lines (brand_id, name, slug) VALUES (${brandId}, 'Retired Line', 'retired-line')`,
    );

    await pg.db.execute(sql`
      WITH dropped AS (DELETE FROM lines WHERE brand_id = ${brandId} RETURNING id)
      DELETE FROM brands WHERE id = ${brandId}
    `);

    const left = await pg.db.execute(sql`
      SELECT (SELECT count(*)::int FROM brands WHERE id = ${brandId}) AS brands,
             (SELECT count(*)::int FROM lines WHERE brand_id = ${brandId}) AS lines
    `);
    expect(left.rows[0]).toMatchObject({ brands: 0, lines: 0 });
  });

  // 0027: two more reasons a crawler row can be unmatched (ADR-012 Wave 2). The
  // important one is `no_anchor` — seed mode used to MINT a catalog row from
  // exactly that state, which is how a flat namespace grew a parallel copy of
  // itself per vendor. An unparseable title is now a question for a curator.
  // Asserted through the constraint, because widening a CHECK in Postgres means
  // dropping and re-adding it, and a re-add that quietly lost a value would look
  // identical from the migration's side.
  it("0027 admits no_anchor and ambiguous, keeps the 0025 reasons, and still refuses an unknown one", async () => {
    const [vendor] = await pg.db
      .insert(vendors)
      .values({ name: "Matching V2 Vendor" })
      .returning({ id: vendors.id });
    const insert = (reason: string | null) =>
      pg.db.insert(listingMatches).values({
        vendorId: vendor!.id,
        listingKey: `v2-${reason ?? "null"}-${Math.random()}`,
        status: "unmatched",
        unmatchedReason: reason as "no_anchor" | "ambiguous" | null,
      });

    // The two 0025 reasons keep their exact meanings and must survive the re-add.
    await expect(insert("market_refusal")).resolves.toBeDefined();
    await expect(insert("no_match")).resolves.toBeDefined();
    await expect(insert("no_anchor")).resolves.toBeDefined();
    await expect(insert("ambiguous")).resolves.toBeDefined();
    // NULL still means "nobody's guess" — an auto link, a curator verdict, or
    // the excludeCigar cascade — and stays legal.
    await expect(insert(null)).resolves.toBeDefined();
    await expect(insert("nonsense")).rejects.toThrow();
  });

  // `category_path` is nullable with NO DEFAULT, and the distinction is
  // load-bearing rather than incidental: NULL means the vendor's breadcrumbs
  // were never captured (every row written before 0027), `{}` means the page
  // genuinely offered none. A DEFAULT '{}' would have erased that difference
  // across the whole backlog the moment the migration applied.
  it("0027 leaves category_path NULL when unset and round-trips a text[]", async () => {
    const [vendor] = await pg.db
      .insert(vendors)
      .values({ name: "Category Path Vendor" })
      .returning({ id: vendors.id });
    const add = async (categoryPath: string[] | undefined) =>
      (
        await pg.db
          .insert(listingMatches)
          .values({ vendorId: vendor!.id, listingKey: `cat-${Math.random()}`, categoryPath })
          .returning({ categoryPath: listingMatches.categoryPath })
      )[0]!.categoryPath;

    // Never captured.
    expect(await add(undefined)).toBeNull();
    // Captured, and the vendor offered none — a different fact, stored differently.
    expect(await add([])).toEqual([]);
    // Captured. Order is the breadcrumb trail and has to survive the round trip.
    expect(await add(["Cigars", "Nicaraguan", "Padrón"])).toEqual(["Cigars", "Nicaraguan", "Padrón"]);
  });

  // The parse a curator inherits instead of redoing by eye. One jsonb blob and
  // not columns because nothing reads it back to make a match — it is evidence,
  // not identity — so the only contract is that it survives the round trip whole.
  it("0027 round-trips a suggested_parse object", async () => {
    const [vendor] = await pg.db
      .insert(vendors)
      .values({ name: "Suggested Parse Vendor" })
      .returning({ id: vendors.id });
    const parse: SuggestedParse = {
      brandId: null,
      brandName: "Padrón",
      lineId: null,
      lineName: "1964 Anniversary",
      blendId: null,
      blendName: null,
      vitolaName: "Exclusivo",
      lengthInches: 5.5,
      ringGauge: 50,
      cleanedName: "Padrón 1964 Anniversary Exclusivo Maduro",
      packaging: "box",
      sticksPerPackage: 10,
      residue: "maduro 10 ct",
      notes: ["anchored brand padron", "two leaves fit under 1964 Anniversary"],
    };

    const [row] = await pg.db
      .insert(listingMatches)
      .values({
        vendorId: vendor!.id,
        listingKey: `parse-${Math.random()}`,
        status: "unmatched",
        unmatchedReason: "ambiguous",
        suggestedParse: parse,
      })
      .returning({ suggestedParse: listingMatches.suggestedParse });
    expect(row!.suggestedParse).toEqual(parse);

    // And an unresolved row that carried no parse is the ordinary pre-0027 shape.
    const [bare] = await pg.db
      .insert(listingMatches)
      .values({ vendorId: vendor!.id, listingKey: `parse-none-${Math.random()}` })
      .returning({ suggestedParse: listingMatches.suggestedParse });
    expect(bare!.suggestedParse).toBeNull();
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

  // 0028 part 1: the crawl registry learns that not every source is a shop
  // (ADR-013 §4). One registry with a discriminator, not two — `crawl_enabled`,
  // the approval posture and the six tables hanging off `vendors.id` are the
  // crawl mechanics of ANY source. The default is what keeps every pre-0028 row
  // meaning exactly what it meant.
  it("0028 defaults vendors.kind to 'vendor' and admits only the three source kinds", async () => {
    const [plain] = await pg.db
      .insert(vendors)
      .values({ name: "Kind Default Shop" })
      .returning({ kind: vendors.kind });
    expect(plain!.kind).toBe("vendor");

    await expect(
      pg.db
        .insert(vendors)
        .values({ name: "Kind Reviewer", kind: "reviewer", purchaseLinkout: false }),
    ).resolves.toBeDefined();
    await expect(
      pg.db
        .insert(vendors)
        .values({ name: "Kind Reference", kind: "reference", purchaseLinkout: false }),
    ).resolves.toBeDefined();

    // A fourth kind is not a kind. Raw so an arbitrary string reaches the
    // DATABASE's CHECK, which is the thing under test.
    await expect(
      pg.db.execute(sql`
        INSERT INTO vendors (name, kind, purchase_linkout)
        VALUES ('Kind Aggregator', 'aggregator', false)
      `),
    ).rejects.toThrow();
  });

  // The discriminator arrives as a CHECK rather than as documentation: a source
  // that is not a shop has no market and is not a purchase destination. It bites
  // at INSERT precisely because `purchase_linkout` DEFAULTS to true — registering
  // halfwheel means writing `false` explicitly, and that loud failure beats a
  // silent "buy at halfwheel" link or a reviewer quietly seeding market evidence.
  it("0028 refuses a non-vendor source that claims a market or a purchase link", async () => {
    const insert = (columns: string, values: string) =>
      pg.db.execute(sql.raw(`INSERT INTO vendors (${columns}) VALUES (${values})`));

    // `focus` on a reviewer is a stocking claim from a site with no inventory —
    // the very predicate `evidencedMarketSql` reads to infer a cigar's market.
    const focused = await insert(
      "name, kind, focus, purchase_linkout",
      "'Focused Reviewer', 'reviewer', 'NC', false",
    ).catch((e: unknown) => e);
    expect((focused as { cause?: { constraint?: string } })?.cause?.constraint).toBe(
      "vendors_non_vendor_source_chk",
    );

    // Omitting purchase_linkout takes the column DEFAULT of true, so the plain
    // registration a caller writes first is exactly the one that fails.
    const defaulted = await insert("name, kind", "'Linkout Reviewer', 'reviewer'").catch(
      (e: unknown) => e,
    );
    expect((defaulted as { cause?: { constraint?: string } })?.cause?.constraint).toBe(
      "vendors_non_vendor_source_chk",
    );

    // Said explicitly on both columns, halfwheel registers.
    await expect(
      insert("name, kind, purchase_linkout", "'Registered Reviewer', 'reviewer', false"),
    ).resolves.toBeDefined();
    // And a shop is untouched: a market focus and a link-out are what it is for.
    await expect(insert("name, focus", "'Untouched Shop', 'CC'")).resolves.toBeDefined();
  });

  // 0028 part 2. A review is not a series: one reviewer publishes one verdict at
  // one URL, so the idempotency key is a real UNIQUE (source, url) and a re-crawl
  // updates the row it already wrote rather than appending a second data point.
  it("0028 keys a review observation on (source, url)", async () => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Review Idempotency Subject') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const add = (source: string, url: string) =>
      pg.db.execute(sql`
        INSERT INTO review_observations
          (source, url, native_scale, native_score, normalized_score, cigar_id)
        VALUES (${source}, ${url}, '0-100', '90', 90, ${cigarId})
      `);

    const url = "https://reviews.example/idempotency";
    await add("halfwheel", url);
    await expect(add("halfwheel", url)).rejects.toThrow();
    // The key is the PAIR: two sources may each review the same address...
    await expect(add("cigardojo", url)).resolves.toBeDefined();
    // ...and one source has many reviews.
    await expect(add("halfwheel", `${url}-2`)).resolves.toBeDefined();
  });

  // Linkage at the most specific level the SOURCE states: the leaf cigar when the
  // reviewer named a vitola, the blend when they reviewed the blend at large.
  // Neither zero nor both is a thing a reviewer can have said.
  it("0028 requires a review observation to name exactly one target", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Target Brand', 'ro-target-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Target Line', 'ro-target-line' FROM b RETURNING id
      ), bl AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Target Blend', 'ro-target-blend' FROM l RETURNING id
      )
      SELECT bl.id AS blend_id FROM b, l, bl
    `);
    const blendId = (chain.rows[0] as { blend_id: string }).blend_id;
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Review Target Subject') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;

    const add = (url: string, onCigar: string | null, onBlend: string | null) =>
      pg.db.execute(sql`
        INSERT INTO review_observations
          (source, url, native_scale, native_score, normalized_score, cigar_id, blend_id)
        VALUES ('halfwheel', ${url}, '0-100', '90', 90, ${onCigar}, ${onBlend})
      `);

    // A score about nothing, and a score claiming both levels at once. Pinned on
    // the constraint name so neither refusal can pass for some other reason.
    const constraintOf = async (url: string, onCigar: string | null, onBlend: string | null) =>
      (
        (await add(url, onCigar, onBlend).catch((e: unknown) => e)) as {
          cause?: { constraint?: string };
        }
      )?.cause?.constraint;
    expect(await constraintOf("https://reviews.example/target-none", null, null)).toBe(
      "review_observations_target_chk",
    );
    expect(await constraintOf("https://reviews.example/target-both", cigarId, blendId)).toBe(
      "review_observations_target_chk",
    );
    await expect(add("https://reviews.example/target-cigar", cigarId, null)).resolves.toBeDefined();
    await expect(add("https://reviews.example/target-blend", null, blendId)).resolves.toBeDefined();
  });

  // The single axis every aggregate averages, and the scales it can be computed
  // from. The CHECK list is REVIEW_SCALES in @cj/domain's review-scores.ts: a
  // scale the code cannot normalize is a row the database will not hold.
  it("0028 bounds normalized_score to 0..100 and admits only the four native scales", async () => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Review Scale Subject') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const add = (url: string, scale: string, native: string, normalized: string) =>
      pg.db.execute(sql`
        INSERT INTO review_observations
          (source, url, native_scale, native_score, normalized_score, cigar_id)
        VALUES ('halfwheel', ${url}, ${scale}, ${native}, ${normalized}, ${cigarId})
      `);

    await expect(add("https://reviews.example/score-below", "0-100", "-1", "-1")).rejects.toThrow();
    await expect(
      add("https://reviews.example/score-above", "0-100", "101", "101"),
    ).rejects.toThrow();
    // Both ends of the axis are legal values, not off-by-one rejections.
    await expect(
      add("https://reviews.example/score-floor", "0-100", "0", "0"),
    ).resolves.toBeDefined();
    await expect(
      add("https://reviews.example/score-ceiling", "0-100", "100", "100"),
    ).resolves.toBeDefined();

    for (const scale of ["0-100", "0-10", "0-5-stars", "letter"]) {
      await expect(
        add(`https://reviews.example/scale-${scale}`, scale, "88", "88"),
      ).resolves.toBeDefined();
    }
    await expect(
      add("https://reviews.example/scale-unknown", "5-cigars", "4", "80"),
    ).rejects.toThrow();
  });

  // The excerpt bound is a licence rule expressed as a constraint, not a
  // formatting preference — which is why the domain writer REFUSES an over-long
  // excerpt rather than truncating it. 400 characters is a pull quote; 401 is the
  // start of storing somebody else's review.
  it("0028 caps a review excerpt at 400 characters and refuses an empty native score", async () => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Review Excerpt Subject') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const add = (url: string, native: string, excerpt: string | null) =>
      pg.db.execute(sql`
        INSERT INTO review_observations
          (source, url, native_scale, native_score, normalized_score, cigar_id, excerpt)
        VALUES ('halfwheel', ${url}, '0-100', ${native}, 90, ${cigarId}, ${excerpt})
      `);

    await expect(
      add("https://reviews.example/excerpt-long", "90", "x".repeat(401)),
    ).rejects.toThrow();
    await expect(
      add("https://reviews.example/excerpt-max", "90", "x".repeat(400)),
    ).resolves.toBeDefined();
    // NULL is the ordinary shape — a score with no pull quote.
    await expect(add("https://reviews.example/excerpt-none", "90", null)).resolves.toBeDefined();

    // The score as the source wrote it is what makes the normalization safe to be
    // wrong about, so an empty one is not a score.
    await expect(add("https://reviews.example/native-empty", "", null)).rejects.toThrow();
  });

  // The bounds on `source` and `url` are denominated in BYTES, because what they
  // protect is a btree entry behind `review_observations_source_url_key` and a
  // btree entry's ~2704-byte ceiling is counted in bytes. `char_length` would let
  // a 2000-CHARACTER multibyte URL through to an opaque index failure at INSERT,
  // which is a storage-layer error where a validation error belongs.
  it("0028 bounds source and url in bytes, not characters", async () => {
    const cigar = await pg.db.execute(
      sql`INSERT INTO cigars (canonical_name) VALUES ('Review Bytes Subject') RETURNING id`,
    );
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const add = (source: string, url: string) =>
      pg.db.execute(sql`
        INSERT INTO review_observations
          (source, url, native_scale, native_score, normalized_score, cigar_id)
        VALUES (${source}, ${url}, '0-100', '90', 90, ${cigarId})
      `);

    const prefix = "https://bytes.example/";
    // 2000 characters and 2001 bytes: on the bound by a character count, over it
    // by the count that matters.
    const overByOne = `${prefix}é${"a".repeat(2000 - prefix.length - 1)}`;
    expect(overByOne).toHaveLength(2000);
    expect(Buffer.byteLength(overByOne, "utf8")).toBe(2001);
    await expect(add("halfwheel", overByOne)).rejects.toThrow();

    // Exactly 2000 bytes, multibyte included, is accepted — the bound is
    // inclusive and counts what the index counts.
    const exact = `${prefix}é${"a".repeat(2000 - prefix.length - 2)}`;
    expect(Buffer.byteLength(exact, "utf8")).toBe(2000);
    await expect(add("halfwheel", exact)).resolves.toBeDefined();

    // The same rule on the slug half of the key: 100 bytes, not 100 characters.
    const overSource = `${"é".repeat(50)}x`;
    expect(Buffer.byteLength(overSource, "utf8")).toBe(101);
    await expect(add(overSource, "https://bytes.example/source-over")).rejects.toThrow();
    await expect(
      add("é".repeat(50), "https://bytes.example/source-exact"),
    ).resolves.toBeDefined();
  });

  // The two delete rules differ, and the asymmetry is the point. `cigar_id`
  // CASCADEs, matching every other cigar-linked observation table — cigars are
  // never hard-deleted (0013 tombstones), so it is a guarantee that never fires.
  // `blend_id` is NO ACTION: retiring a blend that still carries externally
  // sourced evidence must re-point the observations first, not lose data that
  // costs a crawl to reacquire.
  it("0028 cascades observations off a deleted cigar and refuses to retire a reviewed blend", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Delete Brand', 'ro-delete-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Delete Line', 'ro-delete-line' FROM b RETURNING id
      ), bl AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Delete Blend', 'ro-delete-blend' FROM l RETURNING id
      )
      SELECT bl.id AS blend_id FROM b, l, bl
    `);
    const blendId = (chain.rows[0] as { blend_id: string }).blend_id;
    const cigar = await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id)
      VALUES ('Review Delete Subject', ${blendId}) RETURNING id
    `);
    const cigarId = (cigar.rows[0] as { id: string }).id;

    await pg.db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, cigar_id)
      VALUES ('halfwheel', 'https://reviews.example/delete-cigar', '0-100', '90', 90, ${cigarId})
    `);
    await pg.db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, blend_id)
      VALUES ('halfwheel', 'https://reviews.example/delete-blend', '0-100', '92', 92, ${blendId})
    `);

    await pg.db.execute(sql`DELETE FROM cigars WHERE id = ${cigarId}`);
    const afterCigar = await pg.db.execute(
      sql`SELECT count(*)::int AS n FROM review_observations WHERE cigar_id = ${cigarId}`,
    );
    expect((afterCigar.rows[0] as { n: number }).n).toBe(0);

    // The blend keeps its evidence, and the evidence keeps the blend.
    await expect(pg.db.execute(sql`DELETE FROM blends WHERE id = ${blendId}`)).rejects.toThrow();
    await pg.db.execute(
      sql`DELETE FROM review_observations WHERE url = 'https://reviews.example/delete-blend'`,
    );
    await expect(
      pg.db.execute(sql`DELETE FROM blends WHERE id = ${blendId}`),
    ).resolves.toBeDefined();
  });

  // 0028 part 3. `cigar_ancestry` is the ONE definition of what sits under a
  // level, shared by both populations so a critic count and a journal count
  // rendered side by side are counts over the same rows. Ancestry is partial by
  // design (ADR-012), and the `catalog_status = 'active'` filter lives here so
  // both populations inherit it identically.
  it("0028's cigar_ancestry resolves a leaf's parents and excludes catalog tombstones", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Ancestry Brand', 'ro-ancestry-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Ancestry Line', 'ro-ancestry-line' FROM b RETURNING id
      ), bl AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Ancestry Blend', 'ro-ancestry-blend' FROM l RETURNING id
      )
      SELECT b.id AS brand_id, l.id AS line_id, bl.id AS blend_id FROM b, l, bl
    `);
    const {
      brand_id: brandId,
      line_id: lineId,
      blend_id: blendId,
    } = chain.rows[0] as {
      brand_id: string;
      line_id: string;
      blend_id: string;
    };
    const seed = async (name: string, columns: string, values: string) =>
      (
        await pg.db.execute(
          sql.raw(
            `INSERT INTO cigars (canonical_name, ${columns}) VALUES ('${name}', ${values}) RETURNING id`,
          ),
        )
      ).rows[0] as { id: string };
    const ancestry = async (cigarId: string) =>
      (await pg.db.execute(sql`SELECT * FROM cigar_ancestry WHERE cigar_id = ${cigarId}`)).rows;

    // The leaf carries only its blend; line and brand are derived through the
    // registry, which is the authority where it has an opinion.
    const leaf = await seed("Ancestry Full Leaf", "blend_id", `'${blendId}'`);
    expect((await ancestry(leaf.id))[0]).toMatchObject({
      blend_id: blendId,
      line_id: lineId,
      brand_id: brandId,
    });

    // Partial is not missing: a cigar with a brand and no blend still belongs to
    // that brand and must count there, contributing to no blend.
    const brandOnly = await seed("Ancestry Brand Only", "brand_id", `'${brandId}'`);
    expect((await ancestry(brandOnly.id))[0]).toMatchObject({
      blend_id: null,
      line_id: null,
      brand_id: brandId,
    });

    // An excluded row is hidden junk and a merged row is a tombstone whose smokes
    // already moved to the survivor; either contributing would corrupt the count.
    const excluded = await seed(
      "Ancestry Excluded Leaf",
      "blend_id, catalog_status",
      `'${blendId}', 'excluded'`,
    );
    const merged = await seed(
      "Ancestry Merged Leaf",
      "blend_id, catalog_status",
      `'${blendId}', 'merged'`,
    );
    expect(await ancestry(excluded.id)).toHaveLength(0);
    expect(await ancestry(merged.id)).toHaveLength(0);
  });

  // `cigar_id` passes through UNCHANGED rather than being widened: a blend-linked
  // review is about the blend, and presenting it as a particular vitola's score
  // would invent a specificity the reviewer never claimed.
  it("0028's review_observation_scope resolves both target shapes to the same levels", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Scope Brand', 'ro-scope-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Scope Line', 'ro-scope-line' FROM b RETURNING id
      ), bl AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Scope Blend', 'ro-scope-blend' FROM l RETURNING id
      )
      SELECT b.id AS brand_id, l.id AS line_id, bl.id AS blend_id FROM b, l, bl
    `);
    const {
      brand_id: brandId,
      line_id: lineId,
      blend_id: blendId,
    } = chain.rows[0] as {
      brand_id: string;
      line_id: string;
      blend_id: string;
    };
    const cigar = await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id)
      VALUES ('Review Scope Subject', ${blendId}) RETURNING id
    `);
    const cigarId = (cigar.rows[0] as { id: string }).id;

    const onCigar = await pg.db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, cigar_id)
      VALUES ('halfwheel', 'https://reviews.example/scope-cigar', '0-100', '88.5', 88.5, ${cigarId})
      RETURNING id
    `);
    const onBlend = await pg.db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, blend_id)
      VALUES ('halfwheel', 'https://reviews.example/scope-blend', '0-100', '91', 91, ${blendId})
      RETURNING id
    `);
    const scope = async (observationId: string) =>
      (
        await pg.db.execute(
          sql`SELECT * FROM review_observation_scope WHERE observation_id = ${observationId}`,
        )
      ).rows;

    // A vitola review counts at every level above the leaf, its blend derived
    // through `cigars.blend_id` rather than stored a second time.
    expect((await scope((onCigar.rows[0] as { id: string }).id))[0]).toMatchObject({
      cigar_id: cigarId,
      blend_id: blendId,
      line_id: lineId,
      brand_id: brandId,
      normalized_score: "88.50",
    });

    // A blend review counts at the blend and above, and names no vitola.
    expect((await scope((onBlend.rows[0] as { id: string }).id))[0]).toMatchObject({
      cigar_id: null,
      blend_id: blendId,
      line_id: lineId,
      brand_id: brandId,
    });
  });

  // POPULATION PARITY AT THE BLEND. `catalog_status` is applied once, in
  // `cigar_ancestry`, so that both populations inherit it identically — but the
  // blend-linked branch of `review_observation_scope` walks `blends → lines` and
  // never reaches a leaf, so it inherits nothing unless it asks. Without the
  // EXISTS probe a blend whose every leaf has been merged away keeps publishing
  // its critic score while its journal score has already gone silent, and the two
  // numbers rendered side by side are counts over different populations — the one
  // thing a shared ancestry definition exists to prevent.
  it("0028's review_observation_scope drops a blend whose leaves are all merged away", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Empty Brand', 'ro-empty-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Empty Line', 'ro-empty-line' FROM b RETURNING id
      ), bl AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Empty Blend', 'ro-empty-blend' FROM l RETURNING id
      )
      SELECT bl.id AS blend_id FROM b, l, bl
    `);
    const blendId = (chain.rows[0] as { blend_id: string }).blend_id;
    const cigar = await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id)
      VALUES ('Review Empty Subject', ${blendId}) RETURNING id
    `);
    const cigarId = (cigar.rows[0] as { id: string }).id;
    await pg.db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, blend_id)
      VALUES ('halfwheel', 'https://reviews.example/scope-empty', '0-100', '93', 93, ${blendId})
    `);

    const inScope = async () =>
      (
        (
          await pg.db.execute(
            sql`SELECT count(*)::int AS n FROM review_observation_scope WHERE blend_id = ${blendId}`,
          )
        ).rows[0] as { n: number }
      ).n;

    // While the blend has an active leaf, the blend-linked review reports.
    expect(await inScope()).toBe(1);

    // The leaf is merged into a survivor elsewhere — a tombstone, whose smokes
    // and offers have already moved. The blend is now empty of anything the
    // catalogue recognizes.
    await pg.db.execute(
      sql`UPDATE cigars SET catalog_status = 'merged' WHERE id = ${cigarId}`,
    );
    expect(await inScope()).toBe(0);

    // Restoring the leaf restores the reporting: the probe is about the blend's
    // live population, not about the observation, which was never touched.
    await pg.db.execute(
      sql`UPDATE cigars SET catalog_status = 'active' WHERE id = ${cigarId}`,
    );
    expect(await inScope()).toBe(1);
  });

  // The unrated smokes are excluded in the view rather than in each aggregate
  // query, so a journal count is always a count of RATINGS: a blend with forty
  // logged smokes and two ratings has a sample count of two, and says so.
  it("0028's smoke_rating_scope counts ratings, not smokes", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Smoke Brand', 'ro-smoke-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Smoke Line', 'ro-smoke-line' FROM b RETURNING id
      ), bl AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Smoke Blend', 'ro-smoke-blend' FROM l RETURNING id
      )
      SELECT b.id AS brand_id, l.id AS line_id, bl.id AS blend_id FROM b, l, bl
    `);
    const {
      brand_id: brandId,
      line_id: lineId,
      blend_id: blendId,
    } = chain.rows[0] as {
      brand_id: string;
      line_id: string;
      blend_id: string;
    };
    const cigar = await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id)
      VALUES ('Smoke Scope Subject', ${blendId}) RETURNING id
    `);
    const cigarId = (cigar.rows[0] as { id: string }).id;
    const user = await pg.db.execute(
      sql`INSERT INTO users (email) VALUES ('smoke-scope@example.com') RETURNING id`,
    );
    const userId = (user.rows[0] as { id: string }).id;
    const smoke = async (rating: number | null) =>
      (
        await pg.db.execute(sql`
          INSERT INTO smokes (user_id, cigar_id, rating, provenance_source)
          VALUES (${userId}, ${cigarId}, ${rating}, 'manual') RETURNING id
        `)
      ).rows[0] as { id: string };

    const rated = await smoke(90);
    const unrated = await smoke(null);

    const rows = (
      await pg.db.execute(sql`SELECT * FROM smoke_rating_scope WHERE cigar_id = ${cigarId}`)
    ).rows as { smoke_id: string }[];
    expect(rows.map((r) => r.smoke_id)).toEqual([rated.id]);
    expect(rows.map((r) => r.smoke_id)).not.toContain(unrated.id);
    expect(rows[0]).toMatchObject({
      user_id: userId,
      rating: 90,
      blend_id: blendId,
      line_id: lineId,
      brand_id: brandId,
    });
  });

  // The blender gate, fail-closed. `blends` has no market column and inventing
  // one would be a fact nobody established, so Cuban-ness is derived from the
  // leaf's `cigars.type` — the same signal every other CC/NC rule reads. A blend
  // has many leaves and nothing makes them agree, so a CC leaf disqualifies the
  // blend outright and an NC leaf qualifies it only when no leaf contradicts.
  it("0028's blend_market_type lets a CC leaf outrank the NC leaf beside it", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Market Brand', 'ro-market-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Market Line', 'ro-market-line' FROM b RETURNING id
      ), nc AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Market NC', 'ro-market-nc' FROM l RETURNING id
      ), mixed AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Market Mixed', 'ro-market-mixed' FROM l RETURNING id
      )
      SELECT nc.id AS nc_id, mixed.id AS mixed_id FROM b, l, nc, mixed
    `);
    const { nc_id: ncId, mixed_id: mixedId } = chain.rows[0] as {
      nc_id: string;
      mixed_id: string;
    };
    const leaf = (name: string, blendId: string, type: string | null) =>
      pg.db.execute(sql`
        INSERT INTO cigars (canonical_name, blend_id, type) VALUES (${name}, ${blendId}, ${type})
      `);
    const marketType = async (blendId: string) =>
      (await pg.db.execute(sql`SELECT type FROM blend_market_type WHERE blend_id = ${blendId}`))
        .rows[0] as { type: string | null } | undefined;

    await leaf("Market NC Leaf", ncId, "NC");
    expect(await marketType(ncId)).toMatchObject({ type: "NC" });

    await leaf("Market Mixed NC Leaf", mixedId, "NC");
    await leaf("Market Mixed CC Leaf", mixedId, "CC");
    // Only 'NC' contributes to blender roll-ups; 'CC' stops at the marca.
    expect(await marketType(mixedId)).toMatchObject({ type: "CC" });
  });

  // The negative form (`!== 'CC'`) credited a blender on every row nobody had
  // established anything about — 890 of 977 leaves carry a NULL type. So an
  // untyped blend is unknown, not Nicaraguan, and an excluded leaf speaks for
  // nothing at all.
  it("0028's blend_market_type stays NULL for a blend no active leaf types", async () => {
    const chain = await pg.db.execute(sql`
      WITH b AS (
        INSERT INTO brands (name, slug) VALUES ('RO Untyped Brand', 'ro-untyped-brand') RETURNING id
      ), l AS (
        INSERT INTO lines (brand_id, name, slug)
        SELECT id, 'RO Untyped Line', 'ro-untyped-line' FROM b RETURNING id
      ), untyped AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Untyped', 'ro-untyped' FROM l RETURNING id
      ), bare AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Leafless', 'ro-leafless' FROM l RETURNING id
      ), hidden AS (
        INSERT INTO blends (line_id, name, slug)
        SELECT id, 'RO Hidden NC', 'ro-hidden-nc' FROM l RETURNING id
      )
      SELECT untyped.id AS untyped_id, bare.id AS bare_id, hidden.id AS hidden_id
      FROM b, l, untyped, bare, hidden
    `);
    const {
      untyped_id: untypedId,
      bare_id: bareId,
      hidden_id: hiddenId,
    } = chain.rows[0] as {
      untyped_id: string;
      bare_id: string;
      hidden_id: string;
    };
    const marketType = async (blendId: string) =>
      (await pg.db.execute(sql`SELECT type FROM blend_market_type WHERE blend_id = ${blendId}`))
        .rows[0] as { type: string | null } | undefined;

    await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id) VALUES ('Untyped Leaf A', ${untypedId})
    `);
    await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id) VALUES ('Untyped Leaf B', ${untypedId})
    `);
    expect(await marketType(untypedId)).toMatchObject({ type: null });

    // A blend with no leaves at all is still a row in the view, and still unknown.
    expect(await marketType(bareId)).toMatchObject({ type: null });

    // An excluded leaf is hidden junk or an entry a curator hid; it may not
    // qualify the blend its NC type would otherwise credit.
    await pg.db.execute(sql`
      INSERT INTO cigars (canonical_name, blend_id, type, catalog_status)
      VALUES ('Hidden NC Leaf', ${hiddenId}, 'NC', 'excluded')
    `);
    expect(await marketType(hiddenId)).toMatchObject({ type: null });
  });
});

import { sql } from "drizzle-orm";
import { startTestPostgres } from "@cj/db/testing";
import { browseCatalog } from "../catalog-browse.js";
import {
  getLeafSurfaceScores,
  getSurfaceScore,
  getSurfaceScores,
} from "../score-aggregates.js";

// DESIGN-006 rule 3: "Computed on read from the 0028 views, one query per
// surface. The PR measures the leaf-page and drill-header queries on a seeded
// catalogue (~1,000 cigars, ~500 observations) and records the timings;
// materialize only if a surface exceeds 50 ms."
//
//   pnpm --filter @cj/domain bench:surfaces
//
// This is the SURFACE benchmark, and it is deliberately separate from
// bench-score-aggregates.ts. That one asks the materialization question at ten
// times production volume against the analytical reads; this one measures the
// four queries an actual page issues, at the volume the design names, and its
// only job is to answer yes or no to the 50ms gate.
//
// A script and not a test, for the same reason as its sibling: a timing
// assertion in CI measures the runner's contention, not the query.

// The volume DESIGN-006 names. Roughly today's production catalogue.
const BRANDS = 20;
const LINES = 60;
const BLENDS = 200;
const CIGARS = 1000;
const USERS = 20;
const OBSERVATIONS = 500;
const SMOKES = 800;

const REPEATS = 200;

// The gate the design sets. Anything above it is a materialization proposal.
const BUDGET_MS = 50;

interface Timing {
  label: string;
  medianMs: number;
  p95Ms: number;
}

async function time(label: string, run: () => Promise<unknown>): Promise<Timing> {
  await run(); // one warm pass, so the first sample is not the plan cache
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const started = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    medianMs: samples[Math.floor(samples.length / 2)]!,
    p95Ms: samples[Math.floor(samples.length * 0.95)]!,
  };
}

function report(rows: Timing[]): void {
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    const median = row.medianMs.toFixed(2).padStart(8);
    const p95 = row.p95Ms.toFixed(2).padStart(8);
    const verdict = row.p95Ms > BUDGET_MS ? "  OVER BUDGET" : "";
    process.stdout.write(
      `  ${row.label.padEnd(width)}  median ${median} ms   p95 ${p95} ms${verdict}\n`,
    );
  }
}

async function main(): Promise<void> {
  process.stdout.write("booting embedded postgres…\n");
  const pg = await startTestPostgres();
  const db = pg.db;

  try {
    process.stdout.write("seeding…\n");

    await db.execute(sql`
      INSERT INTO brands (name, slug)
      SELECT 'Surf Brand ' || i, 'surf-brand-' || i FROM generate_series(1, ${BRANDS}) AS i
    `);
    await db.execute(sql`
      INSERT INTO lines (brand_id, name, slug)
      SELECT b.id, 'Surf Line ' || i, 'surf-line-' || i
      FROM generate_series(1, ${LINES}) AS i
      JOIN LATERAL (SELECT id FROM brands WHERE slug = 'surf-brand-' || ((i % ${BRANDS}) + 1)) b ON true
    `);
    await db.execute(sql`
      INSERT INTO blends (line_id, name, slug)
      SELECT l.id, 'Surf Blend ' || i, 'surf-blend-' || i
      FROM generate_series(1, ${BLENDS}) AS i
      JOIN LATERAL (SELECT id FROM lines WHERE slug = 'surf-line-' || ((i % ${LINES}) + 1)) l ON true
    `);
    await db.execute(sql`
      INSERT INTO cigars (canonical_name, type, brand_id, line_id, blend_id)
      SELECT 'Surf Cigar ' || i, 'NC', ln.brand_id, bl.line_id, bl.id
      FROM generate_series(1, ${CIGARS}) AS i
      JOIN LATERAL (SELECT id, line_id FROM blends WHERE slug = 'surf-blend-' || ((i % ${BLENDS}) + 1)) bl ON true
      JOIN LATERAL (SELECT brand_id FROM lines WHERE id = bl.line_id) ln ON true
    `);
    // Half the journals public, half private — the viewer population has to
    // discriminate rather than sweep the table, which is the work being measured.
    await db.execute(sql`
      INSERT INTO users (email, journal_visibility)
      SELECT 'surf' || i || '@example.com',
             CASE WHEN i % 2 = 0 THEN 'public' ELSE 'private' END
      FROM generate_series(1, ${USERS}) AS i
    `);
    // Four in five linked to a leaf, one in five stated at the blend — the mix
    // ADR-013 §2's "most specific level" rule produces.
    await db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, cigar_id, blend_id)
      SELECT 'surf-source-' || (i % 5),
             'https://surf.example/r/' || i,
             '0-100',
             (60 + (i % 41))::text,
             (60 + (i % 41))::numeric,
             CASE WHEN i % 5 <> 0 THEN c.id END,
             CASE WHEN i % 5 = 0 THEN bl.id END
      FROM generate_series(1, ${OBSERVATIONS}) AS i
      JOIN LATERAL (SELECT id FROM cigars WHERE canonical_name = 'Surf Cigar ' || ((i % ${CIGARS}) + 1)) c ON true
      JOIN LATERAL (SELECT id FROM blends WHERE slug = 'surf-blend-' || ((i % ${BLENDS}) + 1)) bl ON true
    `);
    await db.execute(sql`
      INSERT INTO smokes (user_id, cigar_id, rating, provenance_source)
      SELECT u.id, c.id, (50 + (i % 51)), 'manual'
      FROM generate_series(1, ${SMOKES}) AS i
      JOIN LATERAL (SELECT id FROM users WHERE email = 'surf' || ((i % ${USERS}) + 1) || '@example.com') u ON true
      JOIN LATERAL (SELECT id FROM cigars WHERE canonical_name = 'Surf Cigar ' || ((i % ${CIGARS}) + 1)) c ON true
    `);
    await db.execute(sql`ANALYZE`);

    const pick = async (query: string): Promise<string[]> => {
      const rows = await db.execute(sql.raw(query));
      return (rows.rows as unknown as { id: string }[]).map((r) => r.id);
    };
    const cigarIds = await pick("SELECT id FROM cigars ORDER BY canonical_name LIMIT 100");
    const blendIds = await pick("SELECT id FROM blends ORDER BY slug LIMIT 50");
    const lineIds = await pick("SELECT id FROM lines ORDER BY slug LIMIT 50");
    const brandIds = await pick("SELECT id FROM brands ORDER BY slug LIMIT 20");
    const viewerId = (await pick("SELECT id FROM users ORDER BY email LIMIT 1"))[0]!;
    const viewer = { userId: viewerId };
    const principal = { userId: viewerId, role: "user" as const };

    process.stdout.write(
      `\nseeded: ${BRANDS} brands / ${LINES} lines / ${BLENDS} blends / ${CIGARS} cigars / ` +
        `${OBSERVATIONS} observations / ${SMOKES} rated smokes\n` +
        `budget: ${BUDGET_MS} ms per surface (DESIGN-006 rule 3)\n\n`,
    );

    let cursor = 0;
    const next = <T,>(pool: T[]): T => {
      cursor = (cursor + 1) % pool.length;
      return pool[cursor]!;
    };

    process.stdout.write("THE RENDERED SURFACES — one query each\n");
    report([
      // The leaf page: own-observations-else-blend, both populations, one query.
      await time("leaf page  /cigars/[id]", () =>
        getLeafSurfaceScores(db, next(cigarIds), viewer),
      ),
      await time("drill header  blend", () => getSurfaceScore(db, "blend", next(blendIds), viewer)),
      await time("drill header  line", () => getSurfaceScore(db, "line", next(lineIds), viewer)),
      await time("drill header  brand", () => getSurfaceScore(db, "brand", next(brandIds), viewer)),
    ]);

    process.stdout.write("\nTHE GROUP GRID — one round trip for a whole screen of cards\n");
    report([
      await time("group cards  50 blends", () => getSurfaceScores(db, "blend", blendIds, viewer)),
      await time("group cards  50 lines", () => getSurfaceScores(db, "line", lineIds, viewer)),
      await time("group cards  20 brands", () => getSurfaceScores(db, "brand", brandIds, viewer)),
    ]);

    process.stdout.write("\nTHE LEAF GRID — the critic join, ordering and filtering the tiles\n");
    report([
      await time("browse  sort=name (join present, unused)", () =>
        browseCatalog({ db, now: () => new Date() }, principal, { limit: 48 }),
      ),
      await time("browse  sort=critic-score:desc", () =>
        browseCatalog({ db, now: () => new Date() }, principal, {
          sort: "critic-score",
          limit: 48,
        }),
      ),
      await time("browse  criticScoreMin=90", () =>
        browseCatalog({ db, now: () => new Date() }, principal, {
          criticScoreMin: 90,
          limit: 48,
        }),
      ),
    ]);

    // The leaf page is the surface the design singles out, and it is the only one
    // whose plan is not obvious from the query — four ungrouped aggregates over
    // two views, cross-joined into one row.
    process.stdout.write("\nPLAN — the leaf page's single statement\n");
    const plan = await db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      WITH leaf AS (
        SELECT ca.cigar_id, ca.blend_id FROM cigar_ancestry ca WHERE ca.cigar_id = ${cigarIds[0]!}::uuid
      ),
      cc AS (
        SELECT round(avg(p.normalized_score), 0)::float8 AS score, count(*)::int AS n
        FROM leaf JOIN review_observation_scope p ON p.cigar_id = leaf.cigar_id
      ),
      cb AS (
        SELECT round(avg(p.normalized_score), 0)::float8 AS score, count(*)::int AS n
        FROM leaf JOIN review_observation_scope p ON p.blend_id = leaf.blend_id
      ),
      jc AS (
        SELECT round(avg(v.voice), 0)::float8 AS score, count(*)::int AS n
        FROM (
          SELECT p.user_id, avg(p.rating) AS voice
          FROM leaf JOIN smoke_rating_scope p ON p.cigar_id = leaf.cigar_id
          WHERE true AND (p.visibility = 'public' OR p.user_id = ${viewerId})
          GROUP BY p.user_id
        ) v
      ),
      jb AS (
        SELECT round(avg(v.voice), 0)::float8 AS score, count(*)::int AS n
        FROM (
          SELECT p.user_id, avg(p.rating) AS voice
          FROM leaf JOIN smoke_rating_scope p ON p.blend_id = leaf.blend_id
          WHERE true AND (p.visibility = 'public' OR p.user_id = ${viewerId})
          GROUP BY p.user_id
        ) v
      )
      SELECT cc.score, cc.n, cb.score, cb.n, jc.score, jc.n, jb.score, jb.n
      FROM cc, cb, jc, jb
    `);
    for (const row of plan.rows as unknown as Record<string, string>[]) {
      process.stdout.write(`  ${Object.values(row)[0]}\n`);
    }

    process.stdout.write(
      `\nDESIGN-006 rule 3 says materialize only if a surface exceeds ${BUDGET_MS} ms.\n` +
        "Any row above marked OVER BUDGET is a proposal to write up, not to build.\n",
    );
  } finally {
    await pg.stop();
  }
}

await main();

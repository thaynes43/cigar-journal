import { sql } from "drizzle-orm";
import { startTestPostgres } from "@cj/db/testing";
import { getScoreAggregate, getScoreAggregates, type ScoreLevel } from "../score-aggregates.js";

// The materialization benchmark behind ADR-013 §3's "decide materialization with
// benchmarks" (issue #199). Run it, do not trust it from memory:
//
//   pnpm --filter @cj/domain bench:scores
//
// It boots the same embedded Postgres 16 the test suite runs against, seeds a
// catalogue roughly ten times production's size, and times the view-backed
// aggregate reads against a materialized-table alternative — including the
// alternative's refresh cost, which is the number a maintained table actually
// has to justify.
//
// It is a script and not a test on purpose: a timing assertion in CI measures the
// runner's contention, not the query. The correctness of everything below is
// covered by score-aggregates.test.ts.

// Roughly ten times the production catalogue as this shipped (977 cigars, no
// review observations yet), with the taxonomy fanned out the way a curated
// catalogue fans out rather than uniformly.
const BRANDS = 40;
const LINES = 120;
const BLENDS = 400;
const BLENDERS = 30;
const CIGARS = 2000;
const USERS = 20;
const OBSERVATIONS = 5000;
const SMOKES = 5000;

const REPEATS = 200;

interface Timing {
  label: string;
  medianMs: number;
  p95Ms: number;
}

async function time(label: string, run: () => Promise<unknown>): Promise<Timing> {
  // One warm pass so the first measurement is not the plan cache being built.
  await run();
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
    process.stdout.write(`  ${row.label.padEnd(width)}  median ${median} ms   p95 ${p95} ms\n`);
  }
}

async function main(): Promise<void> {
  process.stdout.write("booting embedded postgres…\n");
  const pg = await startTestPostgres();
  const db = pg.db;

  try {
    process.stdout.write("seeding…\n");

    // The taxonomy. Every level is minted with generate_series so the shape is
    // reproducible run to run; slugs are unique by construction.
    await db.execute(sql`
      INSERT INTO brands (name, slug)
      SELECT 'Bench Brand ' || i, 'bench-brand-' || i FROM generate_series(1, ${BRANDS}) AS i
    `);
    await db.execute(sql`
      INSERT INTO lines (brand_id, name, slug)
      SELECT b.id, 'Bench Line ' || i, 'bench-line-' || i
      FROM generate_series(1, ${LINES}) AS i
      JOIN LATERAL (
        SELECT id FROM brands WHERE slug = 'bench-brand-' || ((i % ${BRANDS}) + 1)
      ) b ON true
    `);
    await db.execute(sql`
      INSERT INTO blends (line_id, name, slug)
      SELECT l.id, 'Bench Blend ' || i, 'bench-blend-' || i
      FROM generate_series(1, ${BLENDS}) AS i
      JOIN LATERAL (
        SELECT id FROM lines WHERE slug = 'bench-line-' || ((i % ${LINES}) + 1)
      ) l ON true
    `);
    await db.execute(sql`
      INSERT INTO blenders (name, slug)
      SELECT 'Bench Blender ' || i, 'bench-blender-' || i FROM generate_series(1, ${BLENDERS}) AS i
    `);
    await db.execute(sql`
      INSERT INTO blend_blenders (blend_id, blender_id)
      SELECT bl.id, bn.id
      FROM generate_series(1, ${BLENDS}) AS i
      JOIN LATERAL (SELECT id FROM blends WHERE slug = 'bench-blend-' || i) bl ON true
      JOIN LATERAL (
        SELECT id FROM blenders WHERE slug = 'bench-blender-' || ((i % ${BLENDERS}) + 1)
      ) bn ON true
    `);

    // Leaves. One in ten is Cuban, so the blender gate has real work to do rather
    // than admitting everything.
    await db.execute(sql`
      INSERT INTO cigars (canonical_name, type, brand_id, line_id, blend_id)
      SELECT 'Bench Cigar ' || i,
             CASE WHEN i % 10 = 0 THEN 'CC' ELSE 'NC' END,
             ln.brand_id, bl.line_id, bl.id
      FROM generate_series(1, ${CIGARS}) AS i
      JOIN LATERAL (SELECT id, line_id FROM blends WHERE slug = 'bench-blend-' || ((i % ${BLENDS}) + 1)) bl ON true
      JOIN LATERAL (SELECT brand_id FROM lines WHERE id = bl.line_id) ln ON true
    `);

    // Public journals: the default journal population is public-only, so seeding
    // private users would measure an aggregate over an empty set and report a
    // flatteringly fast number for a query that found nothing.
    await db.execute(sql`
      INSERT INTO users (email, journal_visibility)
      SELECT 'bench' || i || '@example.com', 'public' FROM generate_series(1, ${USERS}) AS i
    `);

    // Review observations: four in five linked to a leaf, one in five stated at
    // the blend — the mix ADR-013 §2's "most specific level" rule produces.
    await db.execute(sql`
      INSERT INTO review_observations
        (source, url, native_scale, native_score, normalized_score, cigar_id, blend_id)
      SELECT 'bench-source-' || (i % 5),
             'https://bench.example/r/' || i,
             '0-100',
             (60 + (i % 41))::text,
             (60 + (i % 41))::numeric,
             CASE WHEN i % 5 <> 0 THEN c.id END,
             CASE WHEN i % 5 = 0 THEN bl.id END
      FROM generate_series(1, ${OBSERVATIONS}) AS i
      JOIN LATERAL (SELECT id FROM cigars WHERE canonical_name = 'Bench Cigar ' || ((i % ${CIGARS}) + 1)) c ON true
      JOIN LATERAL (SELECT id FROM blends WHERE slug = 'bench-blend-' || ((i % ${BLENDS}) + 1)) bl ON true
    `);

    await db.execute(sql`
      INSERT INTO smokes (user_id, cigar_id, rating, provenance_source)
      SELECT u.id, c.id, (50 + (i % 51)), 'manual'
      FROM generate_series(1, ${SMOKES}) AS i
      JOIN LATERAL (SELECT id FROM users WHERE email = 'bench' || ((i % ${USERS}) + 1) || '@example.com') u ON true
      JOIN LATERAL (SELECT id FROM cigars WHERE canonical_name = 'Bench Cigar ' || ((i % ${CIGARS}) + 1)) c ON true
    `);

    await db.execute(sql`ANALYZE`);

    const pick = async (query: string): Promise<string[]> => {
      const rows = await db.execute(sql.raw(query));
      return (rows.rows as unknown as { id: string }[]).map((r) => r.id);
    };
    const blendIds = await pick("SELECT id FROM blends ORDER BY slug LIMIT 50");
    const lineIds = await pick("SELECT id FROM lines ORDER BY slug LIMIT 50");
    const brandIds = await pick("SELECT id FROM brands ORDER BY slug LIMIT 50");
    const blenderIds = await pick("SELECT id FROM blenders ORDER BY slug LIMIT 50");
    const byLevel: Record<ScoreLevel, string[]> = {
      cigar: await pick("SELECT id FROM cigars ORDER BY canonical_name LIMIT 50"),
      blend: blendIds,
      line: lineIds,
      brand: brandIds,
      blender: blenderIds,
    };

    process.stdout.write(
      `\nseeded: ${BRANDS} brands / ${LINES} lines / ${BLENDS} blends / ${BLENDERS} blenders / ` +
        `${CIGARS} cigars / ${OBSERVATIONS} observations / ${SMOKES} rated smokes\n\n`,
    );

    process.stdout.write("VIEW-BACKED (what shipped) — one entity, both populations\n");
    const single: Timing[] = [];
    for (const level of ["cigar", "blend", "line", "brand", "blender"] as const) {
      const ids = byLevel[level];
      let cursor = 0;
      single.push(
        await time(level, () => {
          cursor = (cursor + 1) % ids.length;
          return getScoreAggregate(db, level, ids[cursor]!);
        }),
      );
    }
    report(single);

    process.stdout.write("\nVIEW-BACKED — 50 entities in one round trip (a list page)\n");
    const batch: Timing[] = [];
    for (const level of ["blend", "line", "brand", "blender"] as const) {
      batch.push(await time(level, () => getScoreAggregates(db, level, byLevel[level])));
    }
    report(batch);

    // The blender level is the one worth explaining rather than guessing at: it
    // is the only level whose key is not a column on the scope view, so it is the
    // only one whose plan is not obvious from the query.
    process.stdout.write("\nPLAN — blender level, one blender\n");
    const plan = await db.execute(sql`
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
      SELECT bb.blender_id AS key,
             round(avg(p.normalized_score), 2)::float8 AS score,
             count(*)::int AS n
      FROM review_observation_scope p
      JOIN blend_blenders bb ON bb.blend_id = p.blend_id
      WHERE bb.blender_id = ANY (ARRAY[${blenderIds[0]!}]::uuid[])
        AND EXISTS (
          SELECT 1 FROM blend_market_type bm WHERE bm.blend_id = bb.blend_id AND bm.type = 'NC'
        )
      GROUP BY bb.blender_id
    `);
    for (const row of plan.rows as unknown as Record<string, string>[]) {
      process.stdout.write(`  ${Object.values(row)[0]}\n`);
    }

    // The alternative, given its best case: a materialized table with a primary
    // key on the lookup column, so the read is a single index probe over
    // pre-computed rows. If a maintained table cannot beat the views here it
    // cannot beat them anywhere.
    process.stdout.write("\nMATERIALIZED ALTERNATIVE — a maintained table, best case\n");
    await db.execute(sql`
      CREATE MATERIALIZED VIEW bench_blend_scores AS
      SELECT k.id AS blend_id,
             c.score AS critic_score, c.n AS critic_n,
             j.score AS journal_score, j.n AS journal_n
      FROM blends k
      LEFT JOIN (
        SELECT blend_id, round(avg(normalized_score), 2)::float8 AS score, count(*)::int AS n
        FROM review_observation_scope GROUP BY blend_id
      ) c ON c.blend_id = k.id
      LEFT JOIN (
        SELECT blend_id, round(avg(rating), 2)::float8 AS score, count(*)::int AS n
        FROM smoke_rating_scope GROUP BY blend_id
      ) j ON j.blend_id = k.id
    `);
    await db.execute(
      sql`CREATE UNIQUE INDEX bench_blend_scores_pk ON bench_blend_scores (blend_id)`,
    );
    await db.execute(sql`ANALYZE bench_blend_scores`);

    let matCursor = 0;
    const matRead = await time("blend (materialized read)", () => {
      matCursor = (matCursor + 1) % blendIds.length;
      return db.execute(
        sql`SELECT * FROM bench_blend_scores WHERE blend_id = ${blendIds[matCursor]!}`,
      );
    });
    const matRefresh = await time("blend (full refresh)", () =>
      db.execute(sql`REFRESH MATERIALIZED VIEW bench_blend_scores`),
    );
    report([matRead, matRefresh]);

    process.stdout.write(
      "\nThe refresh is the cost a maintained table has to justify: it is what every\n" +
        "review ingest, every smoke save/update/delete, and every curation move that\n" +
        "re-parents a leaf would owe — either in full, or as incremental write hooks at\n" +
        "each of those sites, each of which is a way for a stored number to disagree\n" +
        "with the rows under it.\n",
    );
  } finally {
    await pg.stop();
  }
}

await main();

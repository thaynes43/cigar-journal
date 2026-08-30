import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { brandImages, type BrandImageRow, type Database } from "@cj/db";
import { brandSlug } from "@cj/domain";
import { processPhoto as defaultProcessPhoto, type PhotoStorage, type ProcessedPhoto } from "@cj/photos";
import type { Fetcher } from "./fetcher.js";
import {
  entitiesUrl,
  entityDescription,
  entityLabel,
  lookupChosenEntity,
  nameMatches,
  parseEntities,
  parseSearch,
  probeClaims,
  resolveBrandImage,
  searchUrl,
  selectImageFile,
  WikimediaUnavailableError,
  type BrandImageLookup,
  type WikidataEntity,
} from "./wikidata.js";
import { WIKIDATA_TAXONOMY, taxonomyIsUnseeded, type WikidataTaxonomy } from "./wikidata-taxonomy.js";

// The `crawl --brand-images` job (issue #127): fill the brand wall's uncovered
// shelves with Wikidata/Commons imagery. Writes NO crawl_runs row — crawl_runs
// .vendor_id is NOT NULL and Wikidata is not a vendor (ADR-006); the durable
// record is the brand_images rows themselves plus this run's stdout report.
//
// One brand's failure never ends the batch: it increments the error counter and
// the walk continues, exactly like the vendor ingest's photo isolation.

// Below this a slug is too short to disambiguate safely ("cao", "ep") — the name
// gate would match unrelated entities at a rate no scoring can rescue. It bounds
// the UNATTENDED sweep only: naming a shelf with --brand is a human's own
// disambiguation, so that path ignores it.
const MIN_SLUG_LENGTH = 4;

// How long a negative outcome (no_match / no_image / blocked / error) is honoured
// before the job re-checks it. --refresh overrides.
const RECHECK_AFTER_DAYS = 30;

// Matches the web's MAX_UPLOAD_BYTES: the pipeline downsamples anything larger
// than we serve, so this only bounds what we will decode.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface BrandImagesDeps {
  db: Database;
  fetcher: Fetcher;
  storage: PhotoStorage | null;
  now: () => Date;
  // Injectable so tests need neither sharp nor real image bytes; the CLI wires
  // the real @cj/photos pipeline (mirrors IngestDeps.processPhoto).
  processPhoto?: (input: Buffer, contentType: string) => Promise<ProcessedPhoto>;
  taxonomy?: WikidataTaxonomy;
}

export interface BrandImagesOptions {
  limit?: number | null;
  // Restrict the run to one brand name (exact, case-insensitive) — the way to
  // re-check a single shelf without walking the wall.
  brand?: string | null;
  // Ignore the negative cache AND re-check rows that already carry bytes.
  // Never reaches `ambiguous` (waiting on a human) or `suppressed` (a tombstone).
  refresh?: boolean;
  dryRun?: boolean;
  runId?: string;
}

export interface BrandImagesStats {
  brandsUncovered: number;
  brandsChecked: number;
  resolved: number;
  ambiguous: number;
  noMatch: number;
  noImage: number;
  blocked: number;
  imagesStored: number;
  // Brands this run deliberately left alone: Wikimedia declined to answer
  // (maxlag/HTTP error), or the run has no object store and the row already
  // carries bytes. Deliberately NOT written as a row of any kind — a false
  // negative would then be cached for 30 days, and a stripped row would orphan
  // its objects.
  leftUnchecked: number;
  errors: number;
}

export interface BrandImagesResult {
  status: "succeeded" | "failed";
  stats: BrandImagesStats;
  report: string[];
  error?: string;
}

interface UncoveredBrand {
  brand: string;
  n: number;
}

function emptyStats(): BrandImagesStats {
  return {
    brandsUncovered: 0,
    brandsChecked: 0,
    resolved: 0,
    ambiguous: 0,
    noMatch: 0,
    noImage: 0,
    blocked: 0,
    imagesStored: 0,
    leftUnchecked: 0,
    errors: 0,
  };
}

// The uncovered-brand read. It MIRRORS browseBrands' cover join exactly (active
// rows only, `suppressed` product photos excluded), so "uncovered" means the same
// thing here as it does on the wall — a brand that gains a member photo silently
// drops out of this job's work.
export async function uncoveredBrands(db: Database): Promise<UncoveredBrand[]> {
  const result = await db.execute(sql`
    SELECT nullif(btrim(c.brand), '') AS brand, count(*)::int AS n
    FROM cigars c
    LEFT JOIN product_photos pp ON pp.cigar_id = c.id AND pp.rights <> 'suppressed'
    WHERE c.catalog_status = 'active' AND nullif(btrim(c.brand), '') IS NOT NULL
    GROUP BY 1
    HAVING count(pp.id) = 0
    ORDER BY n DESC, brand ASC
  `);
  return (result.rows as unknown as { brand: string; n: number }[]).map((r) => ({
    brand: r.brand,
    n: Number(r.n),
  }));
}

interface WorkItem {
  slug: string;
  brand: string;
  existing: BrandImageRow | null;
}

// Which uncovered brands this run actually queries. Three cases qualify: no row
// yet, a negative row past the re-check window, and a curator-resolved row whose
// bytes have not been downloaded yet (the architectural hinge — the web records
// the pick, the crawl pod fetches). `--refresh` additionally re-checks rows that
// already carry bytes.
//
// TWO STATES ARE NEVER TOUCHED, and a refactor here must keep it that way:
//   ambiguous  — parked on a human decision; re-querying would churn candidates.
//   suppressed — a rights takedown. It is a TOMBSTONE, never resurrected.
export function selectWork(
  brands: readonly UncoveredBrand[],
  rows: readonly BrandImageRow[],
  now: Date,
  options: BrandImagesOptions,
): WorkItem[] {
  const bySlug = new Map(rows.map((row) => [row.brandSlug, row]));
  const cutoff = new Date(now.getTime() - RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const wanted = options.brand?.trim().toLowerCase();
  const named = wanted != null && wanted.length > 0;
  const work: WorkItem[] = [];

  for (const { brand } of brands) {
    if (named && brand.toLowerCase() !== wanted) continue;
    const slug = brandSlug(brand);
    // "CAO" is a real brand AND a Chinese surname: the sweep will not gamble on a
    // slug this short, but a curator who asks for it by name has already made the
    // call, so --brand overrides the bound rather than silently ignoring them.
    if (!named && slug.length < MIN_SLUG_LENGTH) continue;

    const existing = bySlug.get(slug) ?? null;
    if (existing == null) {
      work.push({ slug, brand, existing: null });
      continue;
    }
    if (existing.rights === "suppressed") continue;
    if (existing.status === "ambiguous") continue;
    if (existing.status === "resolved") {
      // Curator-chosen (or storage-less) row awaiting its bytes, or a forced refresh.
      if (existing.objectKey == null || options.refresh === true) work.push({ slug, brand, existing });
      continue;
    }
    // no_match | no_image | blocked | error — the negative cache.
    if (options.refresh === true || existing.checkedAt < cutoff) work.push({ slug, brand, existing });
  }

  if (options.limit != null) return work.slice(0, options.limit);
  return work;
}

interface StoredObjects {
  objectKey: string;
  thumbKey: string;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
}

// Download the licence-cleared bytes and put both objects. Extends the ADR-007
// key convention with a third prefix: `brand/<slug>/<uuid>.jpg` + `.thumb.jpg`,
// same private bucket, pipeline output only.
async function storeImage(
  deps: BrandImagesDeps,
  storage: PhotoStorage,
  slug: string,
  downloadUrl: string,
): Promise<StoredObjects | { blocked: string }> {
  const image = await deps.fetcher.fetchBinary(downloadUrl);
  if (image.status !== 200) return { blocked: `download:${image.status}` };
  if (image.body.length > MAX_IMAGE_BYTES) return { blocked: "oversize" };

  const process = deps.processPhoto ?? defaultProcessPhoto;
  const processed = await process(image.body, image.contentType);
  const id = randomUUID();
  const objectKey = `brand/${slug}/${id}.jpg`;
  const thumbKey = `brand/${slug}/${id}.thumb.jpg`;
  await storage.put(objectKey, processed.full, processed.contentType);
  await storage.put(thumbKey, processed.thumb, processed.contentType);
  return {
    objectKey,
    thumbKey,
    contentType: processed.contentType,
    width: processed.width,
    height: processed.height,
    bytes: processed.full.length,
  };
}

// A brand's lookup outcome, one line, for the run report and --dry-run.
function reportLine(brand: string, lookup: BrandImageLookup, stored: boolean): string {
  const parts = [`${brand}: ${lookup.status}`];
  if (lookup.qid) parts.push(lookup.qid);
  if (lookup.commonsFile) parts.push(lookup.commonsFile);
  if (lookup.image) parts.push(lookup.image.creditLine);
  if (lookup.status === "ambiguous") parts.push(lookup.candidates.map((c) => c.qid).join(","));
  if (lookup.note) parts.push(`(${lookup.note})`);
  if (stored) parts.push("[stored]");
  return parts.join("  ");
}

// One brand end to end: look it up, store the bytes, upsert the row. Two
// outcomes write NOTHING and leave the brand unchecked — Wikimedia declining to
// answer, and a storage-less run meeting a row that already carries bytes — so
// neither the negative cache nor the bucket learns something false from them.
async function processBrand(
  deps: BrandImagesDeps,
  item: WorkItem,
  options: BrandImagesOptions,
  stats: BrandImagesStats,
  report: string[],
): Promise<void> {
  const taxonomy = deps.taxonomy ?? WIKIDATA_TAXONOMY;

  // A run with no object store can neither replace a stored image nor delete the
  // one it supersedes, so it must not touch a row that already carries bytes:
  // writing the fresh outcome would blank object_key (the CHECK forbids keeping
  // it on a non-resolved row) and strand both objects in the bucket with nothing
  // referencing them. Leave the row exactly as it is and spend no request on it.
  if (deps.storage == null && item.existing?.objectKey != null) {
    stats.leftUnchecked += 1;
    report.push(`${item.brand}: unchecked (no object store, and the row already carries bytes)`);
    return;
  }

  let lookup: BrandImageLookup;
  try {
    // A curator already picked the entity — go straight to its image, do not
    // re-run the search (their verdict outranks the resolver, ADR-006).
    lookup =
      item.existing?.status === "resolved" && item.existing.wikidataQid != null
        ? await lookupChosenEntity(deps.fetcher, item.existing.wikidataQid)
        : await resolveBrandImage(deps.fetcher, item.brand, taxonomy);
  } catch (error) {
    if (error instanceof WikimediaUnavailableError) {
      stats.leftUnchecked += 1;
      report.push(`${item.brand}: unchecked (${error.reason})`);
      return;
    }
    throw error;
  }

  stats.brandsChecked += 1;
  switch (lookup.status) {
    case "resolved":
      stats.resolved += 1;
      break;
    case "ambiguous":
      stats.ambiguous += 1;
      break;
    case "no_image":
      stats.noImage += 1;
      break;
    case "blocked":
      stats.blocked += 1;
      break;
    default:
      stats.noMatch += 1;
  }

  if (options.dryRun === true) {
    report.push(reportLine(item.brand, lookup, false));
    return;
  }

  // Bytes first, then the row — the same ordering as attachProductPhoto, so a
  // failed commit leaves no row pointing at objects that are not there.
  let stored: StoredObjects | null = null;
  let note = lookup.note;
  if (lookup.status === "resolved" && lookup.image != null && deps.storage != null) {
    const result = await storeImage(deps, deps.storage, item.slug, lookup.image.downloadUrl);
    if ("blocked" in result) {
      note = result.blocked;
      lookup = { ...lookup, status: "blocked", image: null };
      stats.resolved -= 1;
      stats.blocked += 1;
    } else {
      stored = result;
    }
  }

  const now = deps.now();
  const values = {
    brandSlug: item.slug,
    brandName: item.brand,
    status: lookup.status,
    wikidataQid: lookup.qid,
    entityUrl: lookup.entityUrl,
    commonsFile: lookup.commonsFile,
    sourceUrl: lookup.image?.descriptionUrl ?? null,
    licenseCode: lookup.image?.licenseCode ?? null,
    licenseName: lookup.image?.licenseName ?? null,
    licenseUrl: lookup.image?.licenseUrl ?? null,
    artist: lookup.image?.artist ?? null,
    creditLine: lookup.image?.creditLine ?? null,
    attributionRequired: lookup.image?.attributionRequired ?? true,
    objectKey: stored?.objectKey ?? null,
    thumbKey: stored?.thumbKey ?? null,
    contentType: stored?.contentType ?? null,
    width: stored?.width ?? null,
    height: stored?.height ?? null,
    bytes: stored?.bytes ?? null,
    candidates: lookup.candidates,
    note,
    runId: options.runId ?? null,
    checkedAt: now,
    updatedAt: now,
  };

  try {
    await deps.db
      .insert(brandImages)
      .values(values)
      // One row per slug — a re-run overwrites the outcome in place, never
      // duplicating. `rights` is deliberately absent from the update set: a
      // curator's approve/suppress outranks the crawler and must survive a re-run.
      .onConflictDoUpdate({ target: brandImages.brandSlug, set: values })
      .returning({ id: brandImages.id });
  } catch (error) {
    if (stored) {
      await deps.storage?.delete(stored.objectKey).catch(() => {});
      await deps.storage?.delete(stored.thumbKey).catch(() => {});
    }
    throw error;
  }

  if (stored) stats.imagesStored += 1;

  // The row no longer points at the previous objects — whether this run REPLACED
  // them (a --refresh that re-stored) or CLEARED them (a --refresh whose fresh
  // lookup came back no_image/blocked/no_match/ambiguous, which the CHECK turns
  // into object_key = NULL). Either way nothing references them again, so they go
  // with the reference. A storage-less run never reaches here holding an old key:
  // the guard at the top of this function returned before the lookup.
  const old = item.existing;
  if (old?.objectKey != null && old.objectKey !== stored?.objectKey) {
    await deps.storage?.delete(old.objectKey).catch(() => {});
    if (old.thumbKey) await deps.storage?.delete(old.thumbKey).catch(() => {});
  }
  report.push(reportLine(item.brand, lookup, stored != null));
}

// Drive one --brand-images run.
export async function runBrandImages(
  deps: BrandImagesDeps,
  options: BrandImagesOptions = {},
): Promise<BrandImagesResult> {
  const stats = emptyStats();
  const report: string[] = [];
  const taxonomy = deps.taxonomy ?? WIKIDATA_TAXONOMY;
  if (taxonomyIsUnseeded(taxonomy)) {
    const guidance =
      "taxonomy is unseeded — run `--brand-images --probe` from the crawl pod and commit the QIDs (see wikidata-taxonomy.ts).";
    report.push(guidance);
    // Writing is WORSE than not running. With no qualifying class every brand
    // reads no_match, and that row IS the 30-day negative cache: the seeded
    // follow-up run the rollout depends on would then find nothing to check and
    // report a clean, empty, green run. Refuse instead — a failed run is visible.
    // --dry-run writes nothing, so it stays available for inspecting the worklist.
    if (options.dryRun !== true) return { status: "failed", stats, report, error: guidance };
  }

  try {
    const brands = await uncoveredBrands(deps.db);
    stats.brandsUncovered = brands.length;
    const rows = await deps.db.select().from(brandImages);
    const work = selectWork(brands, rows, deps.now(), options);

    for (const item of work) {
      try {
        await processBrand(deps, item, options, stats, report);
      } catch (error) {
        stats.errors += 1;
        report.push(`${item.brand}: error (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    // Per-brand isolation is about ONE brand failing, not the substrate failing.
    // An object store that rejects every put (expired credentials, bucket gone)
    // errors every item and would otherwise exit 0 with the damage buried in
    // stdout, and no row written to show anything went wrong. A run that could
    // not complete a single item it attempted is a failed run.
    if (work.length > 0 && stats.errors === work.length) {
      const error = `every brand failed (${stats.errors}/${work.length}) — see the report lines above`;
      return { status: "failed", stats, report, error };
    }
    return { status: "succeeded", stats, report };
  } catch (error) {
    return {
      status: "failed",
      stats,
      report,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- --probe: seed the taxonomy allowlists ------------------------------------

// The read-only run that makes the QID allowlists committable (ADR-006's
// live-verification rule, applied to a data dependency rather than an adapter).
// It walks the uncovered brands, keeps the entities whose name folds onto the
// brand exactly — precisely the set the real run would consider — and prints
// their P31/P279/P452/P1056/P17/P495 values WITH English labels, so a human can
// read "Q…  cigar brand" and decide what belongs in wikidata-taxonomy.ts.
// WRITES NOTHING: no DB writes, no storage, no image requests.
export async function probeBrandTaxonomy(
  deps: BrandImagesDeps,
  options: BrandImagesOptions = {},
): Promise<string[]> {
  const report: string[] = [];
  const brands = await uncoveredBrands(deps.db);
  const wanted = options.brand?.trim().toLowerCase();
  let selected = wanted ? brands.filter((b) => b.brand.toLowerCase() === wanted) : brands;
  if (options.limit != null) selected = selected.slice(0, options.limit);

  const observed = new Map<string, Set<string>>(); // property → qids seen
  const seen: { brand: string; entity: WikidataEntity }[] = [];

  for (const { brand } of selected) {
    try {
      const hits = parseSearch((await deps.fetcher.fetchText(searchUrl(brand))).body);
      if (hits.length === 0) {
        report.push(`${brand}: no search hits`);
        continue;
      }
      const entities = parseEntities((await deps.fetcher.fetchText(entitiesUrl(hits.map((h) => h.id)))).body);
      const matched = entities.filter((entity) => nameMatches(brand, entity));
      if (matched.length === 0) {
        report.push(`${brand}: ${entities.length} hit(s), none name-matching`);
        continue;
      }
      for (const entity of matched) {
        seen.push({ brand, entity });
        for (const [property, qids] of Object.entries(probeClaims(entity))) {
          const bucket = observed.get(property) ?? new Set<string>();
          for (const qid of qids) bucket.add(qid);
          observed.set(property, bucket);
        }
      }
    } catch (error) {
      report.push(`${brand}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // One batched label lookup for every class QID observed, so the printout reads
  // as words rather than opaque Q-numbers.
  const allQids = [...new Set([...observed.values()].flatMap((set) => [...set]))];
  const labels = new Map<string, string>();
  for (let i = 0; i < allQids.length; i += 50) {
    const batch = allQids.slice(i, i + 50);
    if (batch.length === 0) break;
    try {
      for (const entity of parseEntities((await deps.fetcher.fetchText(entitiesUrl(batch))).body)) {
        const label = entityLabel(entity);
        if (label) labels.set(entity.id, label);
      }
    } catch {
      // A label lookup failure costs readability, never correctness.
    }
  }
  const named = (qid: string) => `${qid} (${labels.get(qid) ?? "?"})`;

  for (const { brand, entity } of seen) {
    report.push(`${brand} → ${entity.id} "${entityLabel(entity) ?? "—"}" — ${entityDescription(entity) ?? "no description"}`);
    for (const [property, qids] of Object.entries(probeClaims(entity))) {
      if (qids.length > 0) report.push(`    ${property}: ${qids.map(named).join(", ")}`);
    }
    const file = selectImageFile(entity);
    report.push(`    P18: ${file ?? "—"}`);
  }

  report.push("");
  report.push("distinct claim values observed (candidates for wikidata-taxonomy.ts):");
  for (const [property, qids] of [...observed.entries()].sort()) {
    if (qids.size === 0) continue;
    report.push(`  ${property}: ${[...qids].sort().map(named).join(", ")}`);
  }
  return report;
}

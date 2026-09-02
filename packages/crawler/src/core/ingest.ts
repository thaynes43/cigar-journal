import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { auditLog, enrichmentRequests, productPhotos, vendors, type Database, type SuggestedParse } from "@cj/db";
import {
  auditActor,
  recordPriceObservation,
  recordEnrichmentAttempt,
  enrichmentCoverageForRequest,
  coversMarket,
  coversMarketSql,
  evidencedMarket,
  evidencedMarketSql,
  findUnlinkedNameCollision,
  parseListing,
  mayWriteCatalogPhoto,
  mayWriteCatalogPhotoSql,
  mayReplaceCatalogPhoto,
  mayReplaceCatalogPhotoSql,
  everyHigherTierLookedSql,
  photoAuthority,
  vendorNotRetiredSql,
  type CigarType,
  type EnrichmentOutcome,
  type VendorFocus,
} from "@cj/domain";
import { processPhoto as defaultProcessPhoto, type PhotoStorage, type ProcessedPhoto } from "@cj/photos";
import type { VendorAdapter } from "../adapters/types.js";
import { collectSitemapSamples, collectSitemapUrls } from "./sitemap.js";
import { filterProductUrls, pathOf, robotsGatePath } from "./product-url.js";
import type { JsonLdProduct } from "./jsonld.js";
import { extractProductMarkup } from "./markup.js";
import { isCigarListing, normalizeListing, type NormalizedListing } from "./normalize.js";
import {
  coversAsk,
  createCigarFromListing,
  enrichAsk,
  enrichCandidateKeys,
  existingCrawlerLink,
  rankEnrichCandidates,
  resolveListing,
  toSuggestedParse,
  upsertListingMatch,
  type EnrichAsk,
} from "./match.js";
import { parseRobots } from "./robots.js";
import { openCrawlRun, reclaimStrandedRuns, type SignalHost } from "./run-record.js";
import { CRAWLER_UA_TOKEN, MAX_IMAGE_BYTES, type Fetcher } from "./fetcher.js";

// The run driver (ADR-006). Three modes share one polite walk: `seed` (catalog
// creation + offers + photos), `offers` (offers-only, never creates a cigar), and
// `enrich` (drain the gap-fill queue with targeted lookups). Every non-dry run is
// bracketed by a crawl_runs row; a `--dry-run` fetches (bounded) and reports the
// would-writes without touching the DB or the object store.

// HOW MANY ASKS ONE LANE DRAINS A NIGHT. Raised 10 → 50 (#233) now that a look
// is decided structurally rather than by a trigram floor: at ten a night the
// backlog outran the drain, and the ceiling was set when most looks were being
// thrown away by the floor anyway.
//
// The politeness arithmetic, which is what actually bounds this. One look fetches
// at most MAX_ENRICH_CANDIDATES product pages — 8, and in practice fewer, since
// the prefilter (`rankEnrichCandidates`, match.ts) rarely offers eight URLs that
// name the ask — plus the robots and sitemap reads the whole run shares. An ask
// the enumeration names not at all fetches NOTHING (#240): it is a `no_candidate`,
// not a look. So a 50-request drain is a few hundred pages and at most 400,
// against a seed/offers walk that reads every product URL a vendor publishes
// (Fox's flat sitemap is ~2,035 locs) on the same 2.5s interval. The drain stays
// the SMALL walk of the two; it is a targeted lookup lane, not a catalogue crawl.
// The per-vendor safety cap (`adapter.maxPages`, wired to the fetcher in cli.ts)
// still bounds a run whatever this says.
const ENRICH_DEFAULT_LIMIT = 50;
const MAX_ENRICH_CANDIDATES = 8;

// `vendors.tier`'s own default (migration 0034), restated here for the one case
// the registry read below cannot cover: a vendorId with no row. It is the
// conservative end of the scale, never the price authority.
export const DEFAULT_VENDOR_TIER = 2;

export type CrawlMode = "seed" | "offers" | "enrich";

// How a look left the request. `blocked` is kept apart from `exhausted` because
// "nobody could finish looking" is not a fact about a catalogue (#158).
type Retirement = "open" | "exhausted" | "blocked";

export interface IngestStats {
  pagesFetched: number;
  listingsParsed: number;
  skippedNonCigar: number;
  matchesAuto: number;
  cigarsCreated: number;
  offersWritten: number;
  photosCaptured: number;
  // Catalogue-photo writes REFUSED by the write-authority guard (#170): this
  // vendor's focus is a single market and the cigar's evidenced market is either
  // unknown or the other one. Present only when non-zero, so the JSONB of a run
  // that refused nothing stays byte-identical to what it was before this field
  // existed. Not an error — a refusal is the guard working.
  photosSkippedMarket?: number;
  // Seed/offers listings whose best catalogue candidate was REFUSED on market
  // grounds (#170), leaving the listing unmatched rather than linked or newly
  // created. Optional on the same terms as the field above: absent when zero, so a
  // run that refused nothing serialises exactly as it did before this existed.
  // Worth watching after the Cuban Lou's correction — a lane refusing a lot is
  // more likely to have a wrong `vendors.focus` than a wrong catalogue.
  linksRefusedMarket?: number;
  // Matching v2 (ADR-012 Wave 2). Both absent when zero, on the same terms as
  // the fields above — a run that produced neither serialises exactly as it did
  // before they existed.
  //
  // `linksNoAnchor` IS A REGISTRY DEBT COUNTER, not a link-loss counter, and the
  // difference is the positive-evidence rule: a listing whose title matches no
  // brand alias is ANNOTATED, never detached — if it already had a crawler link
  // it keeps it, with the parse and the verdict attached for curation. So this
  // number measures how much of the registry is still unwritten, and the fix for
  // a high count is aliases in Wave 3 curation, never a looser matcher.
  linksNoAnchor?: number;
  // Listings where the brand anchored and more than one of its leaves fit. A
  // high count points at collapse buckets that still need splitting.
  linksAmbiguous?: number;
  // Listings whose EXISTING link survived a verdict that could not re-derive it.
  // The positive-evidence rule made these invisible in the two counters above —
  // both count verdicts, and a verdict over a linked listing now annotates rather
  // than detaching — so this is what separates "the registry cannot yet explain
  // 500 listings nobody had linked" from "the registry cannot yet explain 500
  // listings we are actively holding links for". The second is the one that says
  // how much a Wave 3 alias session is worth. Absent when zero, like its
  // siblings, so a run that annotated nothing serialises unchanged.
  linksAnnotated?: number;
  errors: number;
  // Present only for a vendor with sitemapSampling configured — absent keeps the
  // JSONB byte-identical for every other vendor.
  sitemapSampling?: {
    samples: number;
    locsPerSample: number[];
    // Marginal contribution per sample (URLs no earlier sample enumerated). The
    // number `sitemapSampling.samples` is tuned from: a trailing 0 means the
    // count is already enough, a non-zero last entry means raise it.
    newPerSample: number[];
    unionLocs: number;
    productLocs: number;
    varied: boolean;
  };
  // Present only on an `enrich` run, so the JSONB stays byte-identical for the
  // other two modes. A nightly drain has to be able to say WHAT it retired and
  // WHERE: under per-vendor budgets (#158) "spent" is a verdict about this vendor
  // and this vendor only, and a summary that omits it is the vendor-blind report
  // the ADR amendment forbids.
  enrich?: {
    // Open requests this vendor selected — already filtered by its own budget.
    requests: number;
    // Looks that COMPLETED (miss + match): the vendor's catalogue was enumerated
    // and some ranked candidate parsed as a product. These are the ones that burn
    // budget — a page that answers 200 with nothing parseable does not count.
    looked: number;
    matched: number;
    // Looks that could not complete: an empty enumeration, no candidate that
    // answered 200, or none that yielded a parseable product. Never
    // budget-burning, separately bounded by ERROR_BUDGET.
    errored: number;
    // Requests this run retired as EXHAUSTED — every counted lane has now
    // completed its looks and none carried the cigar.
    spent: number;
    // Requests this run retired as BLOCKED — every counted lane is retired but at
    // least one burned ERROR_BUDGET without finishing a look. Reported apart from
    // `spent` because it is not a fact about any catalogue (#158): a nightly
    // summary that folded the two together would say "we looked and found
    // nothing" about a vendor nobody could reach.
    blocked: number;
    // Looks that found a listing above the similarity floor and REFUSED to link it
    // (#170): between the open-set SELECT and the write, the cigar's evidenced
    // market resolved to the market this vendor does not trade in. Counted as a
    // completed look (a `miss`) and not as an error, because we did read the
    // vendor's catalogue — what we declined is the conclusion, not the look.
    //
    // Optional on the same terms as its siblings above: absent when zero, so an
    // enrich run that refused nothing serialises byte-identically to what it did
    // before this field existed. An always-present `0` would have rewritten the
    // JSONB of every enrich run in the ledger for a number that says nothing.
    skippedMarket?: number;
    // Looks that MATCHED the listing but were refused the catalogue-photo slot by
    // the write-authority guard (#209). Separate from `matched`, because the
    // request is NOT fulfilled by one: the photo was the point of the ask, so the
    // ask stays open for a vendor that may write it. Absent when zero.
    photoRefused?: number;
    // Asks this enumeration NAMED NOWHERE: no product URL carried one of the
    // ask's identity keys or one of its marca's, so no page was fetched (#240).
    // Not a look, and it burns nothing — the ledger cannot say "we read this
    // catalogue" about pages nobody opened. It is the number to watch after a
    // vendor is enabled: high and steady means this shop does not stock these
    // brands, high and falling means the registry is learning their aliases.
    // Absent when zero, like its siblings.
    noCandidate?: number;
  };
}

export interface IngestDeps {
  db: Database;
  fetcher: Fetcher;
  storage: PhotoStorage | null;
  now: () => Date;
  // Injectable so ingest tests need neither sharp nor real image bytes; the CLI
  // wires the real @cj/photos pipeline.
  processPhoto?: (input: Buffer, contentType: string) => Promise<ProcessedPhoto>;
  // Injectable so a test can drive the #155 SIGTERM handler without signalling —
  // or exiting — the vitest worker. Production leaves it unset and gets `process`.
  signalHost?: SignalHost;
}

export interface IngestOptions {
  adapter: VendorAdapter;
  vendorId: string;
  mode: CrawlMode;
  limit?: number | null;
  dryRun?: boolean;
}

// THIS VENDOR'S REGISTRY POSTURE, read once per run (see runIngest) and threaded
// to every guard that needs it. `focus` is the coarse market claim every write
// guard already read; `tier` is the order of authority ADR-015 adds. They travel
// as one value because the photo guard now reads BOTH — market authority decides
// whether this vendor may write the slot at all, tier decides whether it may take
// the slot from whoever holds it — and two parameters that must come from the same
// registry row are two chances to pass one from somewhere else.
interface VendorPosture {
  focus: VendorFocus | null;
  tier: number;
}

export interface IngestResult {
  crawlRunId: string | null;
  status: "succeeded" | "failed";
  stats: IngestStats;
  error?: string;
  report: string[];
}

export class RobotsDisallowedError extends Error {
  constructor(path: string) {
    super(`robots.txt disallows the crawl target ${path} for our user-agent — refusing to crawl.`);
    this.name = "RobotsDisallowedError";
  }
}

// Scoped to vendors that opted into sitemap sampling. They opted in BECAUSE their
// enumeration is unreliable, so a "succeeded, 0 listings" run there is a silent
// failure that reads as healthy in crawl_runs. A non-sampling vendor with an empty
// sitemap still succeeds-with-zero, exactly as before.
export class SitemapEnumerationEmptyError extends Error {
  constructor(samples: number, unionLocs: number) {
    super(
      `sitemap sampling (${samples} samples) enumerated ${unionLocs} URLs, 0 passing the product gate — ` +
        "refusing to record a silent zero-listing run.",
    );
    this.name = "SitemapEnumerationEmptyError";
  }
}

function emptyStats(): IngestStats {
  return {
    pagesFetched: 0,
    listingsParsed: 0,
    skippedNonCigar: 0,
    matchesAuto: 0,
    cigarsCreated: 0,
    offersWritten: 0,
    photosCaptured: 0,
    errors: 0,
  };
}

function priceToDecimal(priceCents: number | null): string | null {
  return priceCents != null ? (priceCents / 100).toFixed(2) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- robots + sitemap gate ---------------------------------------------------

async function fetchRobots(deps: IngestDeps, adapter: VendorAdapter): Promise<ReturnType<typeof parseRobots>> {
  const robotsUrl = new URL("/robots.txt", adapter.url).toString();
  const { status, body } = await deps.fetcher.fetchText(robotsUrl);
  // A missing/failed robots.txt is treated as fully permissive (RFC 9309).
  return parseRobots(status === 200 ? body : "", CRAWLER_UA_TOKEN);
}

async function productUrls(deps: IngestDeps, adapter: VendorAdapter, stats: IngestStats): Promise<string[]> {
  if (!adapter.sitemapSampling) {
    return filterProductUrls(await collectSitemapUrls(deps.fetcher, adapter.sitemapUrl), adapter);
  }

  const sampled = await collectSitemapSamples(deps.fetcher, adapter.sitemapUrl, {
    samples: adapter.sitemapSampling.samples,
    intervalMs: adapter.sitemapSampling.intervalMs,
  });
  const urls = filterProductUrls(sampled.urls, adapter);
  stats.sitemapSampling = {
    samples: sampled.samples.length,
    locsPerSample: sampled.samples.map((sample) => sample.enumerated),
    newPerSample: sampled.samples.map((sample) => sample.newUrls),
    unionLocs: sampled.urls.length,
    productLocs: urls.length,
    varied: sampled.varied,
  };
  if (urls.length === 0) throw new SitemapEnumerationEmptyError(sampled.samples.length, sampled.urls.length);
  return urls;
}

// --- per-listing ingest ------------------------------------------------------

// WRITE AUTHORITY FOR THE ONE CATALOGUE-PHOTO SLOT (#170).
//
// `product_photos` is UNIQUE(cigar_id), inserted with onConflictDoNothing, and
// nothing in the crawler ever deletes a row. One global slot per cigar, first
// write wins, forever — so unlike a listing match (per-vendor, named, revisable,
// re-written next crawl) a wrong photo here is silent and permanent. That
// asymmetry, not the similarity score, is what makes #170 severe, and it is why
// this guard is STRICTER than the one on the link: the slot may only be filled
// when the cigar's evidenced market is KNOWN and this vendor's focus covers it.
//
// The authority is read HERE, after the listing match has been committed, and
// that ordering is the whole design (option A, SELF-EVIDENCING):
//   * a single-market vendor that links a cigar nobody else stocks becomes its own
//     sole evidence, so it may photograph it — Fox's working seed/enrich lanes are
//     not regressed by this guard at all;
//   * a second vendor of the OTHER market linking the same cigar makes the
//     evidence conflict, which resolves to unknown, and its photo is refused.
//
// A `both`-focus vendor (Cuban Lou's, from migration 0025) is NOT self-evidencing:
// its own link contributes no market evidence, so what gates it is whether a
// FOCUSED vendor already stocks the cigar. It photographs what only it carries and
// never pre-empts Fox on a row Fox stocks. See `mayWriteCatalogPhoto`.
//
// The residual, stated: the first vendor to discover a cigar can always photograph
// it, so a single-market lane that name-matches a brand nobody else stocks still
// fills the slot. Closing that needs INDEPENDENT evidence (`cigars.type`, or a
// different vendor already stocking it), which would mean the discovering vendor
// can never photograph what it found — an owner call, raised as such, not decided
// here.
//
// WHY THIS REPORTS ITS OUTCOME (#209). It used to return `void`, so a REFUSAL was
// indistinguishable from a write at the call site — and on the enrich path that
// difference is the whole request: the drain read "no throw" as `match`, marked the
// ask `fulfilled`, and left the slot empty forever. The three results the caller
// actually has to tell apart:
//   wrote   — the slot now holds a photo (this run's insert, or a concurrent one
//             that won the ON CONFLICT: either way the ask's photo exists);
//   refused — the write-authority guard said no. Nothing was fetched, nothing was
//             written, and nothing about this vendor will change that on the next
//             run; the ask is still open and still needs a different vendor;
//   skipped — there was nothing to do (no storage, no image on the listing, or the
//             slot is held by an authority this vendor may not displace). Not a
//             refusal: the ask is satisfied or was never about a photo.
//
// THE SLOT IS ORDERED, NOT FIRST-COME (ADR-015). An occupied slot used to
// short-circuit unconditionally; now a capture from a HIGHER-tier vendor replaces
// a lower tier's photo — new objects written first, the row swapped in one
// transaction, the old objects dropped after the commit, and the whole thing
// audited as `product_photo.replace`. Same tier or higher, a curator's upload, or
// `rights = 'suppressed'` all still short-circuit; see `mayReplaceCatalogPhoto`.
//
// This is the upgrade path the tiers exist for, and it runs on the SEED/OFFERS
// walk rather than on the drain: an ask whose photo exists is `fulfilled` and the
// drain's open set never re-selects it, so nothing in `enrich` would ever look at
// a filled slot again. A tier-1 vendor walking its own catalogue is what finds the
// tier-2 photo and supersedes it.
type PhotoCapture = "wrote" | "refused" | "skipped";

async function capturePhoto(
  deps: IngestDeps,
  vendorId: string,
  posture: VendorPosture,
  cigarId: string,
  // THE URL THE PHOTO IS FETCHED FROM, resolved by `extractProductMarkup` from the
  // adapter's `photoSource`/`photoUrlRewrite` (ADR-006 amendment 2026-09-02).
  // Separate from `listing.imageUrl` — which is what the markup published and what
  // the offer's raw payload carries — because for two of the 2026-09-02 vendors
  // they differ: Cigarworld's JSON-LD `image` is a 300x51 thumbnail of the asset
  // its `og:image` names, and J.J. Fox's `og:image` carries a 265px resize query.
  // It is also what `product_photos.source_url` records, since that column is the
  // provenance of the bytes in the slot, not of the listing.
  photoUrl: string | null,
  stats: IngestStats,
): Promise<PhotoCapture> {
  if (!deps.storage || !photoUrl) return "skipped";
  const { focus, tier } = posture;

  // ONE READ FOR BOTH QUESTIONS — may this vendor write the slot (market
  // authority), and may it take the slot from whoever holds it (tier). Reading
  // them together is what keeps the answer coherent: two reads could see a
  // curator's suppression land between them.
  const authority = await photoAuthority(deps.db, cigarId);

  // The slot check comes FIRST so `photosSkippedMarket` counts only refusals that
  // would otherwise have written: a cigar whose photo this vendor may not displace
  // is a no-op whatever the market says, and counting it would inflate the number
  // an operator reads as "wrong-market photos this run prevented".
  if (authority.occupant && !mayReplaceCatalogPhoto(tier, authority.occupant)) return "skipped";
  const replacing = authority.occupant;

  // PRE-FLIGHT, not the guard. This read is here for one reason only — a photo we
  // already know we may not write is a photo we should not spend the vendor's
  // bandwidth fetching. The AUTHORITATIVE evaluation is the write's own WHERE
  // clause below, in the write's snapshot; see mayWriteCatalogPhotoSql.
  if (!mayWriteCatalogPhoto(focus, authority)) {
    stats.photosSkippedMarket = (stats.photosSkippedMarket ?? 0) + 1;
    return "refused";
  }

  // Bounded: a vendor's product image is whatever their CMS holds, and an
  // oversize one throws — both call sites already isolate a photo failure into
  // stats.errors rather than losing the offer (ADR-007).
  const image = await deps.fetcher.fetchBinary(photoUrl, MAX_IMAGE_BYTES);
  if (image.status !== 200) {
    stats.errors += 1;
    return "skipped";
  }

  const process = deps.processPhoto ?? defaultProcessPhoto;
  const processed = await process(image.body, image.contentType);
  const id = randomUUID();
  const objectKey = `product/${cigarId}/${id}.jpg`;
  const thumbKey = `product/${cigarId}/${id}.thumb.jpg`;

  await deps.storage.put(objectKey, processed.full, processed.contentType);
  await deps.storage.put(thumbKey, processed.thumb, processed.contentType);

  try {
    // --- the replacement arm (ADR-015) --------------------------------------
    // GUARD AND UPDATE IN ONE STATEMENT, for the reason the insert arm below
    // states: the pre-flight and the write are an image download apart. The WHERE
    // re-states BOTH halves in the write's snapshot — market authority exactly as
    // an insert must satisfy it, and the tier rule against the row as it stands
    // now, so a curator's suppression or a competing swap inside the window
    // simply updates nothing.
    //
    // `rights` goes back to 'pending', which is what a fresh capture from this
    // vendor would have got: the replacement is a NEW photo from a NEW source, and
    // carrying the old row's approval across would launder an unreviewed image
    // through a decision made about a different one.
    if (replacing) {
      const swapped = await deps.db.transaction(async (tx) => {
        const updated = await tx.execute(sql`
          UPDATE product_photos
             SET vendor_id = ${vendorId}::uuid,
                 source_url = ${photoUrl},
                 object_key = ${objectKey},
                 thumb_key = ${thumbKey},
                 content_type = ${processed.contentType},
                 width = ${processed.width},
                 height = ${processed.height},
                 bytes = ${processed.full.length},
                 rights = 'pending'
           WHERE id = ${replacing.photoId}::uuid
             AND ${mayWriteCatalogPhotoSql(focus, sql`${cigarId}::uuid`)}
             AND ${mayReplaceCatalogPhotoSql(tier, sql`${cigarId}::uuid`)}
          RETURNING id
        `);
        if (updated.rows.length === 0) return false;

        // The audit is what makes a crawler DELETING objects reviewable: it names
        // both vendors, both tiers and both key pairs, so the swap can be read —
        // and, if the tiers were wrong, understood — after the old bytes are gone.
        await tx.insert(auditLog).values({
          userId: null,
          ...auditActor(undefined, "import"),
          action: "product_photo.replace",
          smokeId: null,
          before: {
            id: replacing.photoId,
            cigarId,
            vendorId: replacing.vendorId,
            tier: replacing.tier,
            rights: replacing.rights,
            objectKey: replacing.objectKey,
            thumbKey: replacing.thumbKey,
          },
          after: {
            id: replacing.photoId,
            cigarId,
            vendorId,
            tier,
            rights: "pending",
            objectKey,
            thumbKey,
            sourceUrl: photoUrl,
          },
          correlationId: null,
        });
        return true;
      });

      if (swapped) {
        // Only once the swap is durable: the old objects are unreferenced now, and
        // a delete before the commit would strand a live row pointing at nothing.
        // Best-effort, like every other object delete in the tree — a bucket
        // failure must not fail a committed crawl.
        await deps.storage.delete(replacing.objectKey).catch(() => {});
        await deps.storage.delete(replacing.thumbKey).catch(() => {});
        stats.photosCaptured += 1;
        return "wrote";
      }

      // Nothing was written, so our bytes are orphans.
      await deps.storage.delete(objectKey).catch(() => {});
      await deps.storage.delete(thumbKey).catch(() => {});

      // WHICH half of the WHERE failed, told apart the same way the insert arm
      // tells its two zero-row cases apart: re-read the slot. Still replaceable →
      // the tier rule holds and it was the market authority that moved under us,
      // which is a refusal and is counted as one. No longer replaceable → someone
      // else took, suppressed or upgraded the slot, which is a skip.
      const current = await photoAuthority(deps.db, cigarId);
      if (!mayReplaceCatalogPhoto(tier, current.occupant)) return "skipped";
      stats.photosSkippedMarket = (stats.photosSkippedMarket ?? 0) + 1;
      return "refused";
    }

    // --- the insert arm ------------------------------------------------------
    // GUARD AND INSERT IN ONE STATEMENT. `INSERT ... SELECT ... WHERE <authority>`
    // evaluates the write authority in the same snapshot as the write, closing the
    // window the pre-flight above cannot: between that read and here we downloaded
    // and processed an image, and a concurrent lane (locks are per vendor+mode, so
    // a `both` lane and a focused lane run together by design) can link this cigar
    // and revoke our authority in exactly that gap.
    //
    // ON CONFLICT still guards the slot itself, so a zero-row result means one of
    // two things — the slot was taken, or the authority is gone — and the two need
    // opposite answers from the caller. They are told apart below by re-reading the
    // slot, which is one SELECT on the path that already decided not to write.
    const inserted = await deps.db.execute(sql`
      INSERT INTO product_photos
        (cigar_id, vendor_id, source_url, object_key, thumb_key, content_type, width, height, bytes, rights)
      SELECT ${cigarId}::uuid, ${vendorId}::uuid, ${photoUrl}, ${objectKey}, ${thumbKey},
             ${processed.contentType}, ${processed.width}, ${processed.height}, ${processed.full.length},
             'pending'
      WHERE ${mayWriteCatalogPhotoSql(focus, sql`${cigarId}::uuid`)}
      ON CONFLICT (cigar_id) DO NOTHING
      RETURNING id
    `);
    if (inserted.rows.length > 0) {
      stats.photosCaptured += 1;
      return "wrote";
    }

    // Nothing was written, so the bytes we uploaded are orphans either way — the
    // else-branch's cleanup was already here for the ON CONFLICT case and covers
    // both.
    await deps.storage.delete(objectKey).catch(() => {});
    await deps.storage.delete(thumbKey).catch(() => {});

    // Slot filled by someone else → the ask's photo exists, which is the answer the
    // caller needs; slot still empty → the authority moved under us and this is a
    // refusal, counted exactly like the pre-flight's.
    const raced = await deps.db
      .select({ id: productPhotos.id })
      .from(productPhotos)
      .where(eq(productPhotos.cigarId, cigarId))
      .limit(1);
    if (raced[0]) return "wrote";
    stats.photosSkippedMarket = (stats.photosSkippedMarket ?? 0) + 1;
    return "refused";
  } catch (error) {
    await deps.storage.delete(objectKey).catch(() => {});
    await deps.storage.delete(thumbKey).catch(() => {});
    throw error;
  }
}

// Match a listing, write its offer, and (seed only) create the catalog cigar.
// Match + offer commit in one transaction; the photo is captured after, in its
// own path, so a photo failure never rolls back an offer (ADR-007 isolation).
async function ingestListing(
  deps: IngestDeps,
  options: IngestOptions,
  posture: VendorPosture,
  crawlRunId: string | null,
  url: string,
  listing: NormalizedListing,
  product: JsonLdProduct,
  photoUrl: string | null,
  stats: IngestStats,
): Promise<void> {
  const now = deps.now();
  const listingKey = pathOf(url);
  const { focus } = posture;

  const cigarId = await deps.db.transaction(async (tx) => {
    // `vendorFocus` is the seed/offers half of #170, and the half that has already
    // fired in production: BOTH live cross-market rows came through here, not
    // through the drain. A CC vendor walking its own sitemap trigram-matched an NC
    // catalogue row and auto-linked it. The guard is a pure negative filter — it
    // can only ever refuse a link, never redirect one.
    const result = await resolveListing(tx, listing.name, { vendorFocus: focus });
    // THE LINK THIS LISTING ALREADY HAS. Read before the arms decide, because
    // under the positive-evidence rule it is an INPUT to the decision.
    const priorLink = await existingCrawlerLink(tx, options.vendorId, listingKey);
    let linkedCigarId: string | null = null;
    let status: "auto" | "unmatched";
    // Only ever set alongside status='unmatched'; see listing_matches.unmatched_reason.
    let unmatchedReason: "market_refusal" | "no_match" | "no_anchor" | "ambiguous" | null = null;
    // The parse rides an unresolved row into triage (0027). Null on a clean link:
    // there is nothing for a curator to resolve, and a stale parse on a row that
    // has since become a link reads as an open question that is not open.
    let suggestedParse: SuggestedParse | null = null;
    // POSITIVE EVIDENCE ONLY — the rule this whole block turns on.
    //
    // `no_anchor`, `ambiguous` and `none` are all statements about what the
    // REGISTRY could not do. None of them is evidence that an existing link is
    // wrong: a title that anchored last night and does not tonight has almost
    // always met a registry gap, not a different cigar. v2's first draft let each
    // of them clear `cigar_id`, which meant every alias we had not written yet
    // silently detached a working link and threw away the offer history hanging
    // off it — the matcher deciding, on silence, to undo work a crawl had already
    // done correctly.
    //
    // So these arms ANNOTATE. The row keeps its status and its cigar, and gains
    // the parse plus this verdict, which is exactly the material a curator needs
    // to close the registry gap. A link is only ever moved by a POSITIVE finding:
    // a parse that resolves to a DIFFERENT leaf (the `match` arm), or the
    // cross-market refusal (#192), which is itself positive evidence — it names
    // the candidate and the conflicting market, and its unlink behaviour is
    // deliberately unchanged.
    let silentVerdict: "no_anchor" | "ambiguous" | "no_match" | null = null;

    if (result.kind === "match") {
      linkedCigarId = result.hit.cigarId;
      status = "auto";
    } else if (result.kind === "refused") {
      // A REFUSAL DOES NOT CREATE, in seed mode either. We found a strong
      // candidate and declined it on market grounds — that is an unresolved
      // question, not evidence of a new cigar. Falling through to
      // createCigarFromListing (which is what this did before #192) would mint a
      // duplicate of the row we just refused every time the refusal was wrong,
      // and a wrong refusal is exactly what a wrong `vendors.focus` produces
      // (#170: Cuban Lou's was recorded 'CC' while selling Perdomo). A bad link
      // is named, revisable and re-written next crawl; a duplicate catalog row is
      // none of those. So: leave the listing UNMATCHED, with no cigar, for the
      // triage queue a curator already works.
      status = "unmatched";
      unmatchedReason = "market_refusal";
      suggestedParse = toSuggestedParse(result.parse);
      stats.linksRefusedMarket = (stats.linksRefusedMarket ?? 0) + 1;
    } else if (result.kind === "no_anchor") {
      // THE CHANGE ADR-012 WAS WRITTEN FOR. No brand alias matched this title, so
      // there is nothing to anchor identity on — and seed mode used to mint from
      // exactly this state, which is how every new vendor grew a parallel catalog
      // (Cuban Lou's: 56 rows over ground Fox already covered). The listing is
      // recorded with the parse attached so a curator can see how far the resolver
      // got and why it stopped — as triage if nothing was linked, as an annotation
      // on the link if something was.
      status = "unmatched";
      silentVerdict = "no_anchor";
      stats.linksNoAnchor = (stats.linksNoAnchor ?? 0) + 1;
    } else if (result.kind === "sampler") {
      // A mixed box is not one catalog cigar (docs/ddd/cigar-industry-vocabulary.md).
      // It shares `ambiguous` as its stored reason because 0027 widened the CHECK
      // by exactly two values and a sampler is, from the queue's point of view,
      // the same instruction — a human decides, nothing is minted. It does NOT
      // share the counter: `linksAmbiguous` is read as "collapse buckets still
      // needing a split", and a shop's sampler shelf would drown that signal.
      // The parse says which it is, in words, on the row.
      status = "unmatched";
      silentVerdict = "ambiguous";
    } else if (result.kind === "ambiguous") {
      // The brand anchored and more than one of its leaves fits. Minting would be
      // the collapse-bucket failure in reverse: a new row for a product the
      // catalog already holds — possibly twice, which is why it is ambiguous.
      status = "unmatched";
      silentVerdict = "ambiguous";
      stats.linksAmbiguous = (stats.linksAmbiguous ?? 0) + 1;
    } else if (options.mode === "seed" && priorLink == null) {
      // The one arm that mints, and it mints a STRUCTURED row: the brand
      // anchored, we looked under it, and this cigar is genuinely not there yet.
      //
      // "NOT THERE YET" IS A CLAIM THE SCOPE QUERY CANNOT MAKE ALONE. It only
      // sees rows attributable to the anchored brand, and 516 of prod's 570
      // unlinked rows are attributable to none — so a brand that anchors, finds
      // nothing under itself and mints would create a second row for a cigar the
      // catalog already holds under a name that does not start with the marca.
      // One unscoped pass over the unlinked rows turns that mint into a question.
      // Wave 3 retires this check with the bridge clause it defends.
      const collision = await findUnlinkedNameCollision(tx, result.parse.cleanedName);
      if (collision) {
        status = "unmatched";
        silentVerdict = "ambiguous";
        stats.linksAmbiguous = (stats.linksAmbiguous ?? 0) + 1;
      } else {
        linkedCigarId = await createCigarFromListing(tx, result.parse);
        stats.cigarsCreated += 1;
        status = "auto";
      }
    } else {
      // No leaf under this brand fits. In offers mode that has always been a
      // triage row; in seed mode over a listing that ALREADY LINKS, the mint above
      // is skipped, because minting a second row for a listing whose first row we
      // are still holding is the duplicate this wave exists to prevent.
      status = "unmatched";
      silentVerdict = "no_match";
    }

    // REGISTRY SILENCE NEVER BREAKS A LINK. The arms above recorded a verdict
    // about what the registry could not do; only here does it become either a
    // triage row or an annotation, and which one it becomes depends solely on
    // whether this listing already has a link worth keeping.
    if (silentVerdict != null) {
      suggestedParse = toSuggestedParse(result.parse, silentVerdict);
      if (priorLink != null) {
        linkedCigarId = priorLink;
        status = "auto";
        stats.linksAnnotated = (stats.linksAnnotated ?? 0) + 1;
      } else {
        unmatchedReason = silentVerdict;
      }
    }

    const match = await upsertListingMatch(tx, {
      vendorId: options.vendorId,
      listingKey,
      cigarId: linkedCigarId,
      status,
      now,
      unmatchedReason,
      suggestedParse,
      // The vendor's own breadcrumb taxonomy — parsed since the crawler was
      // written, used for one boolean category gate, and thrown away ever since.
      // It is the single structured taxonomy signal a vendor gives us (ADR-012),
      // so it is now kept next to the parse it informs.
      categoryPath: listing.categoryPath,
      runId: crawlRunId,
    });
    // THE ROW'S OUTCOME, NOT THIS RUN'S VERDICT — the same distinction the photo
    // path below learned the hard way. `status` is what the resolver decided;
    // `match` is what the listing_matches row actually says after the upsert, and
    // they disagree on every row a curator or an agent owns (591 on prod), which
    // upsertListingMatch returns untouched. Counting the resolver's verdict
    // reported an auto match for a listing whose row was never written and whose
    // `cigar_id` is still null — a nightly overcount of exactly the population the
    // guard exists to protect.
    if (match.status === "auto" && match.cigarId != null) stats.matchesAuto += 1;

    // One offers write path shared with record_price — the 24h dedupe skips an
    // identical observation (ADR-009). Crawler offers link to their cigar through
    // the listing match (curator-authoritative), so cigar_id stays null here.
    const observation = await recordPriceObservation(tx, {
      cigarId: null,
      vendorId: options.vendorId,
      sourceName: null,
      sourceUrl: null,
      listingMatchId: match.id,
      listingUrl: url,
      packaging: listing.packaging,
      sticksPerPackage: listing.sticksPerPackage,
      priceCents: listing.priceCents,
      currency: listing.currency,
      inStock: listing.inStock,
      priceType: "retail",
      raw: { listing, product },
      seenAt: now,
    });
    if (observation.inserted) stats.offersWritten += 1;

    // THE ROW'S DECISION, NOT THIS RUN'S CANDIDATE. `linkedCigarId` is what the
    // resolver computed a moment ago; `match.cigarId` is what the listing_matches
    // row actually says after the upsert, and the two disagree precisely where it
    // matters. upsertListingMatch DECLINES to rewrite a row a curator or an agent
    // decided (ADR-006, migration 0017) and returns it untouched — 591 such rows
    // on prod, every one of them an `unmatched` verdict on a listing the resolver
    // still name-matches. Returning the local candidate meant the photo path then
    // fired against the very cigar the agent had rejected, on every crawl, forever:
    // the link was correctly refused and the one permanent artifact was written
    // anyway. Reading the committed row makes the rejection stick — a declined
    // upsert yields null and nothing is captured — and, on a row an agent
    // CONFIRMED against a different cigar, aims the capture at that cigar instead
    // of at ours, which is the same rule producing the other right answer.
    return match.cigarId;
  });

  if (cigarId) {
    try {
      await capturePhoto(deps, options.vendorId, posture, cigarId, photoUrl, stats);
    } catch (error) {
      // Photo ingestion is isolated from the offer write (ADR-007).
      stats.errors += 1;
      void error;
    }
  }
}

// --- mode: seed / offers -----------------------------------------------------

async function walkListings(
  deps: IngestDeps,
  options: IngestOptions,
  posture: VendorPosture,
  crawlRunId: string | null,
  stats: IngestStats,
  report: string[],
): Promise<void> {
  const { adapter } = options;
  const robots = await fetchRobots(deps, adapter);
  const gatePath = robotsGatePath(adapter);
  if (!robots.isAllowed(gatePath)) {
    throw new RobotsDisallowedError(gatePath);
  }

  let urls = await productUrls(deps, adapter, stats);
  if (options.limit != null) urls = urls.slice(0, options.limit);

  for (const url of urls) {
    if (!robots.isAllowed(pathOf(url))) continue;
    try {
      const { status, body } = await deps.fetcher.fetchText(url);
      if (status !== 200) {
        stats.errors += 1;
        continue;
      }
      const { product, category, categorySource, photoUrl } = extractProductMarkup(body, adapter);
      if (!product) continue;
      const listing = normalizeListing(product, category, categorySource);
      if (!listing) continue;
      stats.listingsParsed += 1;

      if (!isCigarListing(listing, adapter)) {
        stats.skippedNonCigar += 1;
        continue;
      }

      if (options.dryRun) {
        report.push(
          `${options.mode === "seed" ? "seed " : "offer"}  ${pathOf(url)}  ${listing.name}  ` +
            `price=${priceToDecimal(listing.priceCents) ?? "-"} stock=${listing.inStock ?? "-"}`,
        );
        stats.offersWritten += 1;
        continue;
      }

      await ingestListing(deps, options, posture, crawlRunId, url, listing, product, photoUrl, stats);
    } catch (error) {
      stats.errors += 1;
      void error;
    }
  }
}

// --- mode: enrich ------------------------------------------------------------

async function nameSimilarity(deps: IngestDeps, a: string, b: string): Promise<number> {
  const result = await deps.db.execute(sql`SELECT similarity(${a}, ${b}) AS sim`);
  return Number((result.rows as unknown as { sim: number }[])[0]?.sim ?? 0);
}

async function drainEnrichment(
  deps: IngestDeps,
  options: IngestOptions,
  posture: VendorPosture,
  crawlRunId: string | null,
  stats: IngestStats,
  report: string[],
): Promise<void> {
  const { adapter } = options;
  const robots = await fetchRobots(deps, adapter);
  const gatePath = robotsGatePath(adapter);
  if (!robots.isAllowed(gatePath)) {
    throw new RobotsDisallowedError(gatePath);
  }

  const urls = await productUrls(deps, adapter, stats);
  const candidates = urls.map((url) => ({ url, keys: enrichCandidateKeys(pathOf(url)) }));

  const limit = options.limit ?? ENRICH_DEFAULT_LIMIT;

  // The per-vendor open set (ADR-006 amendment 2026-08-30, migration 0023). Three
  // things changed from the pre-0023 `WHERE status = 'pending'`:
  //
  //   * The budget test is against THIS VENDOR'S ledger row, not the request's
  //     shared counter. A request Fox has spent is still open to 2 Guys.
  //   * `exhausted` is IN the open set. That is the entire reopen mechanism: a
  //     newly enabled vendor has no ledger row, so `COALESCE(attempts, 0) = 0`
  //     and the first run picks the row straight up — no reopen job, no cron, no
  //     backfill. "Exhausted" only ever meant "exhausted at the vendors that
  //     looked", and a vendor that might carry the brand is new evidence.
  //   * `in_progress` is in it too. The drain no longer WRITES that state, but a
  //     row stranded by an older image (or a crash mid-rollout) must still be
  //     reachable — nothing else re-selects it (#157 defect 2).
  //
  // `fulfilled` is deliberately absent: one catalogue photo per cigar (ADR-007)
  // means the ask is answered. The join to `cigars` also kills the per-request
  // SELECT the old loop did, so the canonical name and market arrive in one read.
  //
  // THE MARKET FILTER READS THE EVIDENCED MARKET, NOT `cigars.type` (#170). On the
  // raw column the predicate is inert for 884 of prod's 971 active cigars, because
  // `coversMarketSql` admits an unknown market by design — so a CC lane could and
  // would select 91% of the catalogue. The evidenced market resolves 878 of those
  // 884 from links the crawler already wrote (see evidencedMarketSql), which is
  // what turns a filter that is correct-but-inert into one that bites.
  //
  // The same fragment is SELECTED as `market` and handed to finalizeEnrichment, so
  // the rollup's denominator is computed from the identical value this open set was
  // filtered with. Two evaluations of a correlated subquery per candidate row is
  // the price of that coupling, and at LIMIT 50 it is not a price worth optimizing
  // away — a drain that filters on one market while the rollup counts on another
  // holds requests open forever.
  //
  // AND THE TIER CLAUSE (ADR-015). `everyHigherTierLookedSql` is the last filter
  // because it is the newest and the most easily misread: it removes an ask that a
  // BETTER source has not looked at yet, so this lane fills only what the tiers
  // above it could not. It is inert for a tier-1 vendor (nothing is above it), and
  // it makes fallback a property of ONE RUN — `--all-enabled --mode enrich` walks
  // the fleet serially in tier order in one process, so tier 1's misses are in the
  // ledger before tier 2's open set is selected. Under a per-vendor CronJob
  // calendar the same clause is still correct, just a night slower per tier.
  const open = await deps.db.execute(sql`
    SELECT r.id AS request_id, c.id AS cigar_id, c.canonical_name,
           c.brand, c.line, c.brand_id, c.line_id, c.blend_id,
           br.aliases AS brand_aliases, ln.aliases AS line_aliases,
           ${evidencedMarketSql(sql`c.id`)} AS market
    FROM enrichment_requests r
    JOIN cigars c ON c.id = r.cigar_id
    LEFT JOIN brands br ON br.id = c.brand_id
    LEFT JOIN lines ln ON ln.id = c.line_id
    LEFT JOIN enrichment_attempts a
           ON a.request_id = r.id AND a.vendor_id = ${options.vendorId}
    WHERE r.status IN ('pending', 'in_progress', 'exhausted')
      AND ${coversMarketSql(sql`${posture.focus}::text`, evidencedMarketSql(sql`c.id`))}
      AND ${vendorNotRetiredSql(sql`COALESCE(a.attempts, 0)`, sql`COALESCE(a.errors, 0)`)}
      AND ${everyHigherTierLookedSql(posture.tier, sql`r.id`, sql`c.id`)}
    ORDER BY r.created_at
    LIMIT ${limit}
  `);
  const pending = open.rows as unknown as {
    request_id: string;
    cigar_id: string;
    canonical_name: string;
    // The ask's STRUCTURE, read in the same query as its name. What the candidate
    // comparison needs is the row's own taxonomy, not a re-parse of its name: the
    // prod ask `HdM Epicure Especial` carries `brand_id` for Hoyo de Monterrey
    // while its name abbreviates the marca to a spelling no alias holds.
    brand: string | null;
    line: string | null;
    brand_id: string | null;
    line_id: string | null;
    blend_id: string | null;
    brand_aliases: string[] | null;
    line_aliases: string[] | null;
    market: CigarType | null;
  }[];

  // `skippedMarket` and `photoRefused` are deliberately NOT seeded to 0 — they are
  // absent-when-zero (see IngestStats.enrich) and are created on first use.
  const enrich: NonNullable<IngestStats["enrich"]> = {
    requests: pending.length,
    looked: 0,
    matched: 0,
    errored: 0,
    spent: 0,
    blocked: 0,
  };
  stats.enrich = enrich;

  for (const request of pending) {
    const ask = enrichAsk({
      cigarId: request.cigar_id,
      canonicalName: request.canonical_name,
      brand: request.brand,
      line: request.line,
      brandId: request.brand_id,
      lineId: request.line_id,
      blendId: request.blend_id,
      brandAliases: request.brand_aliases,
      lineAliases: request.line_aliases,
    });

    const ranked = rankEnrichCandidates(ask, candidates, MAX_ENRICH_CANDIDATES);

    const outcome = await tryEnrichCandidates(
      deps,
      options,
      posture,
      crawlRunId,
      ask,
      ranked,
      candidates.length,
      stats,
      report,
    );
    if (outcome === "error") enrich.errored += 1;
    // `no_candidate` is not a look and must never be counted as one (#240): no
    // page was fetched, so nothing was read, so nothing can be concluded. It was
    // being counted here — 48 "looks" against a run that fetched 242 pages — and
    // that arithmetic is what made the drain read as busy while it did nothing.
    else if (outcome !== "no_candidate") enrich.looked += 1;
    if (outcome === "match") enrich.matched += 1;
    if (outcome === "no_candidate") enrich.noCandidate = (enrich.noCandidate ?? 0) + 1;
    // A photo refusal is a COMPLETED look (`looked` above) that is not a `match`:
    // the listing was found and linked, and the artifact the ask existed for was
    // refused. Counting it as matched would report a fulfilled ask that is still
    // open, which is the misreport #209 is about.
    if (outcome === "photo_refused") enrich.photoRefused = (enrich.photoRefused ?? 0) + 1;

    if (options.dryRun) continue;

    const retired = await finalizeEnrichment(deps, options, request.request_id, request.market, outcome);
    if (retired === "exhausted") enrich.spent += 1;
    else if (retired === "blocked") enrich.blocked += 1;
  }
}

// What one vendor's look CONCLUDED — three outcomes, not a boolean, because "no
// match at V is evidence about V only" makes the difference between a failed look
// and a completed one load-bearing (ADR-006 amendment 2026-08-30).
//
//   match — a listing cleared the similarity floor.
//   miss  — we READ this vendor's catalogue and it does not carry the cigar.
//           Honest evidence; it burns one of this vendor's two attempts. THE LINE
//           IS A PAGE THIS RUN ACTUALLY OPENED — see `no_candidate` below.
//   no_candidate — the enumeration named this ask NOWHERE, so no page was fetched
//           and nothing was read (#240). It burns no attempt and it is not a look.
//           This used to be a `miss`, on the reasoning that the enumeration IS the
//           vendor's product list, so nothing resembling the cigar in it is itself
//           the evidence. That reasoning has one load-bearing premise — that the
//           prefilter offering zero URLs means the vendor's shelf holds nothing
//           like the ask — and prod falsified it: the slug-overlap prefilter was
//           its own private matcher, and it scored zero on asks the vendors
//           demonstrably stock. Four nights, 58 attempts, 58 `miss`, 0 cigars
//           enriched, with the queue clearing by exhaustion. A verdict about a
//           catalogue that can be manufactured by a defect in our own shortlist is
//           not evidence about that catalogue, and `exhausted` must go back to
//           meaning "a vendor was read and the cigar was not there".
//
//           WHAT THIS LEAVES OPEN, stated rather than discovered: an ask no lane
//           can name never retires. It costs nothing — zero fetches, every night —
//           but it holds its place in the oldest-first open set, so a queue with
//           many such asks drains fewer new ones per run. The lever is the same
//           one the rest of this module documents (an alias in the registry, or a
//           lane that stocks the brand), and the counter that makes it visible is
//           `IngestStats.enrich.noCandidate`.
//   error — the look could not COMPLETE, so it says nothing about any catalogue:
//           it never burns an attempt, and ERROR_BUDGET bounds it so a permanently
//           broken vendor cannot pin the request open and re-fetch the same
//           failures every night.
//   photo_refused — a MATCH whose catalogue-photo write the authority guard
//           refused (#209). Its own outcome because it must not behave like any of
//           the three above: it is not a `match` (the artifact the ask exists for
//           was not written, so the ask is not fulfilled), and it is emphatically
//           not a `miss` — the catalogue plainly carries the cigar, so burning an
//           attempt would march the request toward `exhausted`, whose meaning is
//           "we read this catalogue and it is not there". Two refusals would then
//           retire the ask under a sentence that is false. See finalizeEnrichment.
//
// THE LINE BETWEEN THE LAST TWO IS A PARSED PRODUCT, NOT A 200. An over-matching
// product gate answers 200 all day and parses nothing: the live probe recorded in
// this PR's ADR-006 amendment had 2 Guys' `/store/` prefix enumerate 1,462 locs
// that were gift-registry pages carrying no schema.org Product, and `parsed=0` was
// the true signal (the probe's own `needs-attention` misattributed it to the
// vendor). Counting that as a miss would burn real budget for a gate defect and
// then report "2 Guys looked and does not carry it" — manufactured evidence about
// a vendor, which is precisely what the amendment forbids. So a look is COMPLETE
// only once some ranked candidate yielded a parseable product listing — the same
// `parsed` count `--probe` reports. Three shapes therefore land on `error`: an
// empty enumeration, no candidate that answered 200, and candidates that answered
// 200 with nothing a product parser could read.
//
// A parsed product that is an accessory, or that does not structurally cover the
// ask, is a MISS and not an error: we did read the vendor's catalogue, and what
// it holds is not this cigar.
//
// THE COMPARISON RIDES MATCHING V2 (#233). It used to be one trigram call —
// `similarity(cigars.canonical_name, listing.name) > 0.55` — which is the v1 rule
// the seed and offers paths left behind in Wave 2, kept here only because nothing
// had rewritten it. ADR-012 predicted exactly how it fails and prod's drain then
// recorded it: a blend-level ask (`Drew Estate Liga Privada No. 9`) against a
// vitola-level title (`Liga Privada No. 9 Corona Viva`) scores under the floor,
// so Fox was recorded as not carrying a cigar it visibly stocks — a `miss` is
// written to the ledger as evidence about that catalogue, so a matcher defect
// was being laundered into a factual claim about a vendor.
//
// `coversAsk` (match.ts) now decides admission and TRIGRAM IS DEMOTED TO A
// RANKER over the candidates it admits. That is the whole of its remaining job:
// it never opens a door, it only chooses among doors already open, so the two
// pathologies ADR-012 measured (distinct products scoring above true siblings)
// can reorder a shortlist but can no longer create or refuse a link.
//
// Consequently the loop now READS EVERY RANKED CANDIDATE instead of stopping at
// the first one over the floor — a ranker that cannot see the alternatives is not
// a ranker. The page cost is unchanged in the worst case and bounded by
// MAX_ENRICH_CANDIDATES either way; see ENRICH_DEFAULT_LIMIT for the arithmetic.
async function tryEnrichCandidates(
  deps: IngestDeps,
  options: IngestOptions,
  posture: VendorPosture,
  crawlRunId: string | null,
  ask: EnrichAsk,
  ranked: { url: string }[],
  enumerated: number,
  stats: IngestStats,
  report: string[],
): Promise<EnrichmentOutcome> {
  const { adapter } = options;
  const { focus } = posture;
  if (enumerated === 0) return "error";
  if (ranked.length === 0) return "no_candidate";

  // Did we actually READ this vendor's catalogue? A 200 is not enough — see the
  // header: a gate that admits non-product pages answers 200 and parses nothing.
  let parsed = false;
  const admitted: {
    url: string;
    listing: NormalizedListing;
    product: JsonLdProduct;
    photoUrl: string | null;
    sim: number;
  }[] = [];

  for (const candidate of ranked) {
    const { status, body } = await deps.fetcher.fetchText(candidate.url);
    if (status !== 200) {
      stats.errors += 1;
      continue;
    }
    const { product, category, categorySource, photoUrl } = extractProductMarkup(body, adapter);
    if (!product) continue;
    const listing = normalizeListing(product, category, categorySource);
    if (!listing) continue;
    parsed = true;
    stats.listingsParsed += 1;
    if (!isCigarListing(listing, adapter)) {
      stats.skippedNonCigar += 1;
      continue;
    }

    const parse = await parseListing(deps.db, listing.name);
    if (!coversAsk(ask, parse)) continue;

    // A LISTING THAT ALREADY RESOLVES TO A DIFFERENT CATALOG ROW IS NOT OURS TO
    // REPOINT, and this guard is what keeps the fix from becoming a regression.
    // Coverage is deliberately one-way, so Fox's `Liga Privada No. 9 Corona Viva`
    // covers the blend-level ask — but a seed walk already linked that listing to
    // the Corona Viva row, which is the MORE specific and therefore better answer
    // for it. Letting the drain win that tug-of-war would move the link (and the
    // offer history hanging off it) from the vitola row onto the blend row, and
    // because the title anchors no brand the seed walk would read `no_anchor`
    // next crawl, annotate, and leave the theft standing. A blend-level ask is
    // not positive evidence against a vitola-level link — the same rule the seed
    // path applies when it refuses to unlink on silence.
    //
    // Skipping it is not a lie about the catalogue: the look simply moves to the
    // next candidate, and a vendor whose every covering listing belongs to other
    // rows genuinely has no unclaimed listing to offer this ask.
    const prior = await existingCrawlerLink(deps.db, options.vendorId, pathOf(candidate.url));
    if (prior != null && prior !== ask.cigarId) continue;

    admitted.push({
      url: candidate.url,
      listing,
      product,
      photoUrl,
      sim: await nameSimilarity(deps, ask.canonicalName, listing.name),
    });
  }

  // Trigram's one remaining job: order the shortlist. Ties keep enumeration
  // order, which is the slug-overlap rank the candidates arrived in.
  admitted.sort((a, b) => b.sim - a.sim);
  const best = admitted[0];
  if (!best) return parsed ? "miss" : "error";

  {
    const candidate = { url: best.url };
    const listing = best.listing;
    const product = best.product;

    if (options.dryRun) {
      report.push(
        `enrich ${pathOf(candidate.url)}  ${listing.name}  (sim=${best.sim.toFixed(2)}) → ${ask.canonicalName}`,
      );
      return "match";
    }

    const now = deps.now();
    // WRITE AUTHORITY, re-evaluated at the write (#170). The open set already
    // filtered on the evidenced market, so this normally agrees — it is here
    // because the two reads are seconds of polite HTTP apart, and in that window a
    // curator can set `cigars.type` or another lane can link the row and turn an
    // unknown market into a known, conflicting one. Authority belongs at the write
    // site; a filter on the way in is an optimization, not a guarantee.
    //
    // Evaluated INSIDE the transaction that writes the match, so the check and the
    // write see one snapshot.
    const outcome = await deps.db.transaction(async (tx): Promise<"refused" | "declined" | "linked"> => {
      if (!coversMarket(focus, await evidencedMarket(tx, ask.cigarId))) return "refused";

      // THE PRIOR LINK, RE-READ AT THE WRITE, for exactly the reason the market
      // check above is re-read here: the admission scan is seconds of polite HTTP
      // away, and a seed walk on another lane can link this listing to its own
      // best leaf inside that window. Authority belongs at the write site; the
      // check during admission is an optimization, not a guarantee. `declined` is
      // the right arm — the row says something other than "linked to this cigar",
      // which is precisely what that outcome already means.
      const priorAtWrite = await existingCrawlerLink(tx, options.vendorId, pathOf(candidate.url));
      if (priorAtWrite != null && priorAtWrite !== ask.cigarId) return "declined";

      const match = await upsertListingMatch(tx, {
        vendorId: options.vendorId,
        listingKey: pathOf(candidate.url),
        cigarId: ask.cigarId,
        status: "auto",
        now,
        // The drain only ever LINKS, so any reason the row carried from a previous
        // non-link is stale and is cleared with the write — and so is any parse,
        // which described a question this link has just answered.
        unmatchedReason: null,
        suggestedParse: null,
        // Evidence about the listing, kept regardless of the verdict (0027).
        categoryPath: listing.categoryPath,
        runId: crawlRunId,
        // THE CLAIM, and this call site is the only one that asks for it (#245).
        // A reasonless agent `unmatched` is the catalogue's state at the moment
        // a curation lane swept it, and this ask is catalogue state it did not
        // have; 883 of prod's 1,881 listing rows are in exactly that shape, and
        // they are the ones the open asks name. The guard decides whether this
        // row is one of them — the flag only says the drain is entitled to ask.
        claimAgentUnmatched: true,
      });
      // THE COMMITTED ROW, NOT THIS RUN'S VERDICT — the same distinction the seed
      // path and the photo path (#209) both had to learn. `upsertListingMatch`
      // still DECLINES to rewrite a protected row and returns it untouched, so
      // counting a match here would report a link that was never written — and
      // against precisely the population the guard exists to protect. A declined
      // upsert is a miss: the row says something other than "linked to this
      // cigar", and no arithmetic on our side changes that.
      //
      // Narrower than it was, and still the authority (#245). The claim above
      // hands the guard one more row shape it may rewrite; it does not make this
      // read optional. What survives `declined` now is a genuinely protected row
      // — a curator's verdict, a reasoned agent unmatch, an agent row already
      // pointing elsewhere — which is what makes the miss honest rather than
      // arithmetic about half the vendor's catalogue.
      const committed = match.status === "auto" && match.cigarId === ask.cigarId;
      if (committed) stats.matchesAuto += 1;

      // The offer is written either way. It is a fact about the LISTING —
      // this shop, this price, today — and it hangs off `match.id`, which exists
      // whoever owns the verdict. Discarding an observation because a human
      // decided the link differently would throw away the price history the
      // curator's own row depends on.
      const observation = await recordPriceObservation(tx, {
        cigarId: null,
        vendorId: options.vendorId,
        sourceName: null,
        sourceUrl: null,
        listingMatchId: match.id,
        listingUrl: candidate.url,
        packaging: listing.packaging,
        sticksPerPackage: listing.sticksPerPackage,
        priceCents: listing.priceCents,
        currency: listing.currency,
        inStock: listing.inStock,
        priceType: "retail",
        raw: { listing, product },
        seenAt: now,
      });
      if (observation.inserted) stats.offersWritten += 1;
      return committed ? "linked" : "declined";
    });

    // A refusal ends the LOOK, not just this candidate: the conflict is a property
    // of (this vendor, this cigar), so every remaining candidate would be refused
    // for the same reason. It scores as a `miss` — we read the vendor's catalogue
    // and declined to conclude from it — never as an `error`, which would burn
    // ERROR_BUDGET on a guard doing its job and re-fetch the same pages nightly.
    if (outcome === "refused") {
      if (stats.enrich) stats.enrich.skippedMarket = (stats.enrich.skippedMarket ?? 0) + 1;
      return "miss";
    }

    // A DECLINED UPSERT ENDS THE LOOK TOO, and it must end it BEFORE the photo.
    // The row belongs to someone who answered this question differently — a
    // curator, or an agent who gave a reason or pointed the listing at another
    // cigar; capturing a catalogue photo for `ask.cigarId` on the strength of a
    // link that was refused is the exact shape of #209, one path over. Not counted
    // as a market skip — nothing was refused on market grounds — and not an error:
    // we read the catalogue and someone had already answered the question.
    if (outcome === "declined") return "miss";

    // THE PHOTO IS THE ASK, so its refusal cannot be reported as the ask fulfilled
    // (#209). This used to be a fire-and-forget call whose only visible failure was
    // a throw: `capturePhoto` returned void, so a refusal and a write were the same
    // thing here, and the request went on to be marked `fulfilled` — terminal in
    // the drain's open set — with the slot still empty. The ADR-006 amendment that
    // makes the catalogue photo the point of an enrichment request is exactly what
    // makes that fatal rather than untidy.
    //
    // A refusal is now its own outcome. What it must NOT do is burn the vendor's
    // attempt: `attempts` running out is what licenses `exhausted`, and `exhausted`
    // asserts "we read this vendor's catalogue and the cigar is not in it" — which
    // this vendor's own link disproves. Two refusals producing that verdict would
    // be the ledger laundering the ADR amendment forbids.
    //
    // THE RESIDUAL, and it is a real one: this leaves the ask open against a vendor
    // whose refusal is usually structural (a focused vendor already stocks the row,
    // so a `both` lane will be refused again tomorrow), and nothing bounds the
    // retry. That is the deliberate trade — an ask that is visibly stuck beats an
    // ask silently retired under a false verdict — and it is why the refusal is
    // WRITTEN to the ledger rather than merely counted: the backlog press names the
    // refusing lane in `photoRefusedVendors`, so the operator can see why a row
    // will not clear and disable the lane that is holding it.
    //
    // A capture that THROWS is still reported as `match` and still marks the ask
    // fulfilled. That is the one half of #209 left standing, and deliberately: a
    // throw is a transport or pipeline failure rather than a verdict, `miss` would
    // be false about the catalogue and `error` would retry it against ERROR_BUDGET,
    // and choosing between those is a product call this correctness pass should not
    // make on its own.
    let captured: PhotoCapture = "skipped";
    try {
      captured = await capturePhoto(deps, options.vendorId, posture, ask.cigarId, best.photoUrl, stats);
    } catch {
      stats.errors += 1;
    }
    return captured === "refused" ? "photo_refused" : "match";
  }
}

// Write this vendor's verdict to the ledger, then RECOMPUTE the request's cached
// status from it. Returns HOW this look retired the request, if it did.
//
// The ledger is the authority and `enrichment_requests.status` is a cache of the
// rollup over it, because the rollup's denominator — the vendors eligible for this
// cigar — changes without any request being touched. Recomputing on every finalize
// is what makes enabling a vendor reopen a row and disabling one retire it, with
// no reopen job anywhere in the system.
//
// The drain no longer claims the request with `status = 'in_progress'` first. That
// was a request-level lock on a per-vendor operation: with two lanes it let one
// vendor skip a row another was looking at, and a crash between the claim and the
// finalize stranded the row where nothing re-selected it (#157 defect 2). The
// increment is an atomic upsert instead, so a crash mid-drain simply leaves the row
// open and two overlapping same-vendor runs record two real looks rather than
// losing one to a read-modify-write (#157 defect 1 degraded to a benign
// double-count, with no FOR UPDATE SKIP LOCKED and no reaper).
async function finalizeEnrichment(
  deps: IngestDeps,
  options: IngestOptions,
  requestId: string,
  // The EVIDENCED market, carried over from the open-set SELECT so the rollup's
  // denominator is computed from the same value the drain filtered on (#170 §2c).
  market: CigarType | null,
  outcome: EnrichmentOutcome,
): Promise<Retirement> {
  const now = deps.now();
  return deps.db.transaction<Retirement>(async (tx) => {
    await recordEnrichmentAttempt(tx, { requestId, vendorId: options.vendorId, outcome, at: now });

    // `enrichment_requests.attempts` is now a REPORTING total of completed looks
    // across every vendor — never a budget again. Incremented in SQL rather than
    // read-modify-written, and on every COMPLETED look (miss or match, never an
    // error), so it stays a true count and legacy pre-0023 values — which counted
    // real looks too — keep their meaning. A `photo_refused` look is excluded for
    // the same reason it is excluded from the per-vendor counter: the two numbers
    // mean the same thing and must not disagree about the same look.
    if (outcome !== "error" && outcome !== "photo_refused" && outcome !== "no_candidate") {
      await tx
        .update(enrichmentRequests)
        .set({ attempts: sql`${enrichmentRequests.attempts} + 1` })
        .where(eq(enrichmentRequests.id, requestId));
    }

    if (outcome === "match") {
      await tx
        .update(enrichmentRequests)
        .set({ status: "fulfilled", resolvedAt: now })
        .where(eq(enrichmentRequests.id, requestId));
      return "open";
    }

    // A PHOTO REFUSAL RETIRES NOTHING. It is not `fulfilled` (the slot is empty) and
    // it cannot be rolled up toward `exhausted` either, because the ledger row it
    // just wrote carries attempts = 0: this vendor has not spent a look, so
    // `retired()` is false for it and the rollup below would be reading a lane that
    // still owes the ask. Short-circuiting is the same answer the rollup would
    // give, one query cheaper, and it says so at the point where a reader asks why.
    // A NO-CANDIDATE LOOK RETIRES NOTHING EITHER, and for the same arithmetic
    // reason one step earlier: its ledger row carries attempts = 0, so `retired()`
    // is false for this vendor and the rollup below would be reading a lane that
    // still owes the ask. The difference from a photo refusal is only WHY the lane
    // still owes it — there the catalogue was read and the artifact refused, here
    // the catalogue was never opened (#240).
    if (outcome === "photo_refused" || outcome === "no_candidate") {
      await tx
        .update(enrichmentRequests)
        .set({ status: "pending", resolvedAt: null })
        .where(eq(enrichmentRequests.id, requestId));
      return "open";
    }

    const coverage = await enrichmentCoverageForRequest(tx, requestId, market);
    if (coverage.exhausted) {
      await tx
        .update(enrichmentRequests)
        .set({ status: "exhausted", resolvedAt: now })
        .where(eq(enrichmentRequests.id, requestId));
      return "exhausted";
    }
    // Everything else stays `pending`, and the two reasons are different facts.
    //
    // BLOCKED — every counted lane is retired, but at least one burned
    // ERROR_BUDGET without finishing a look. `exhausted` would be a lie here:
    // nobody could finish looking, and the ledger would carry `attempts = 0`
    // under a verdict that reads "we looked and found nothing". It is not written
    // as `exhausted` and it does not set resolved_at; the honest surface is the
    // rollup, which reports it as blocked, and `retryExhausted` clears it by
    // filing a fresh ask with a fresh error budget.
    //
    // OPEN — no lane counts at all, or one still owes a look. Same reasoning one
    // step earlier, and it self-heals the moment a lane goes live. Clearing
    // resolved_at matters on the reopen path, where a row that had been retired is
    // live again.
    await tx
      .update(enrichmentRequests)
      .set({ status: "pending", resolvedAt: null })
      .where(eq(enrichmentRequests.id, requestId));
    return coverage.blocked ? "blocked" : "open";
  });
}

// --- entry -------------------------------------------------------------------

// PRECONDITION, and it is not enforceable from here: a non-dry run must be entered
// while holding this lane's advisory lock (cli.ts wraps the call in
// withVendorLaneLock). The stranded-run sweep below is only correct under it —
// without the lock it could fail a run that is genuinely in flight.
export async function runIngest(deps: IngestDeps, options: IngestOptions): Promise<IngestResult> {
  const stats = emptyStats();
  const report: string[] = [];

  // This vendor's market, read ONCE from the REGISTRY rather than from the adapter.
  // The adapter carries the same field, but every market predicate downstream —
  // the drain's open set, the exhaustion rollup, both write guards — reads
  // `vendors.focus`, and a crawl acting on a different copy of that fact could
  // write where the rollup says it may not. One indexed read per run removes the
  // whole class of drift. NULL focus means unknown, which the negative filter
  // treats as covering everything and the photo guard treats as no authority to
  // assert either way.
  //
  // `tier` rides the same read for the same reason (ADR-015): the adapter carries
  // a seed value, the ROW is what the drain's eligibility clause and the photo
  // slot's replacement rule are evaluated against, and an admin re-tiering a shop
  // must take effect on the next run without an adapter change. A row that
  // somehow has none falls back to the column's own default — the conservative
  // end, never the price authority.
  const vendorRows = await deps.db
    .select({ focus: vendors.focus, tier: vendors.tier })
    .from(vendors)
    .where(eq(vendors.id, options.vendorId))
    .limit(1);
  const posture: VendorPosture = {
    focus: vendorRows[0]?.focus ?? null,
    tier: vendorRows[0]?.tier ?? DEFAULT_VENDOR_TIER,
  };

  // The crawl_runs row this pass belongs to, threaded to the write sites so an
  // audited write (a market downgrade unlinking a listing) names the run that made
  // it. Null on a dry run, which opens no row to name.
  const run = async (crawlRunId: string | null): Promise<void> => {
    if (options.mode === "enrich") await drainEnrichment(deps, options, posture, crawlRunId, stats, report);
    else await walkListings(deps, options, posture, crawlRunId, stats, report);
  };

  if (options.dryRun) {
    try {
      await run(null);
      stats.pagesFetched = deps.fetcher.pagesFetched;
      return { crawlRunId: null, status: "succeeded", stats, report };
    } catch (error) {
      stats.pagesFetched = deps.fetcher.pagesFetched;
      return { crawlRunId: null, status: "failed", stats, error: errorText(error), report };
    }
  }

  // #155: close out anything a previous process for this lane left `running`
  // before opening a new row, so a pod lost to SIGKILL/OOM/node-loss does not leave
  // an immortal row nothing re-selects. Lock-scoped, hence no age ceiling — see
  // reclaimStrandedRuns.
  await reclaimStrandedRuns(deps.db, { vendorId: options.vendorId, kind: options.mode });

  const record = await openCrawlRun(deps.db, {
    vendorId: options.vendorId,
    kind: options.mode,
    now: deps.now,
    host: deps.signalHost,
  });

  try {
    await run(record.crawlRunId);
    stats.pagesFetched = deps.fetcher.pagesFetched;
    await record.close("succeeded", { stats });
    return { crawlRunId: record.crawlRunId, status: "succeeded", stats, report };
  } catch (error) {
    stats.pagesFetched = deps.fetcher.pagesFetched;
    const message = errorText(error);
    await record.close("failed", { stats, error: message });
    return { crawlRunId: record.crawlRunId, status: "failed", stats, error: message, report };
  } finally {
    // Idempotent with close(); the point is that a throw between the two — or a
    // caller that keeps the process alive — never leaves a listener holding a
    // reference to a run that is already over.
    record.dispose();
  }
}

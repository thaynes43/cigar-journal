import { brandSlug } from "@cj/domain";
import type { BrandImageCandidate } from "@cj/db";
import type { Fetcher } from "./fetcher.js";
import { WIKIDATA_TAXONOMY, type WikidataTaxonomy } from "./wikidata-taxonomy.js";

// The Wikidata/Wikimedia Commons client behind the brand-image fallback (issue
// #127). Posture per ADR-006: an OFFICIAL DOCUMENTED API client, the same footing
// as the r/cubancigars Reddit Data API — not a vendor crawl. No vendors row, no
// adapter, no robots-gated HTML walk, no crawl_runs row (crawl_runs.vendor_id is
// NOT NULL and Wikidata is not a vendor). It rides the shared polite fetcher, so
// it inherits the ≥2.5s global serial limiter and the identifying User-Agent that
// already satisfies the Wikimedia UA policy verbatim.
//
// Two Action-API calls per brand, deliberately not SPARQL: wbsearchentities
// matches labels AND aliases on free text (exact-label SPARQL misses aliases),
// and one wbgetentities returns everything disambiguation needs plus P18 in a
// single request. query.wikidata.org would add a hostname, harsher throttling and
// flakier availability while answering nothing a claims check does not.

export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

// wbgetentities accepts up to 50 ids per request; the search cap keeps us well
// under it with one call per brand.
const SEARCH_LIMIT = 15;

// Commons rasterizes SVG to PNG for thumbnails, and most brand logos on Commons
// ARE SVG — which processPhoto's accepted set rejects. Always ask for a thumb at
// this width: it hands back a raster and, in the ordinary case, a small file.
// It is NOT a size bound. Commons can answer with no thumburl at all, and an
// accepted-mime original (20–40MB) is then the download — the actual cap is
// fetchBinary's `maxBytes`, which every caller of these URLs passes.
const THUMB_WIDTH = 1024;

// Mirrors @cj/photos' pipeline ACCEPTED set (not importable — it is private to
// the pipeline). Only consulted on the `url` fallback path, when Commons returned
// no thumbnail at all.
const ACCEPTED_MEDIA = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]);

// Machine licence codes we will store and display. Anything else — or absent
// licence metadata — blocks BEFORE a single byte is requested. Unknown licence =
// no image; that is the whole safety story.
const LICENSE_ALLOWLIST = /^(cc0|cc-by-[\d.]+|cc-by-sa-[\d.]+|pd-.*|public domain)$/;

// Licences with no attribution condition. The credit line is still stored and
// rendered (provenance is not optional here), but `attribution_required` records
// the legal fact.
const NO_ATTRIBUTION_REQUIRED = /^(cc0|pd-.*|public domain)$/;

// A description token that makes a generic "brand"/"business" entity plausibly a
// cigar brand — supporting evidence only, never qualifying on its own.
const TOBACCO_DESCRIPTION = /\b(cigars?|cigarillo|tobacco|puro|habanos?)\b/i;

// Claim properties read during disambiguation.
const P_INSTANCE_OF = "P31";
const P_SUBCLASS_OF = "P279";
const P_INDUSTRY = "P452";
const P_PRODUCT = "P1056";
const P_COUNTRY = "P17";
const P_ORIGIN_COUNTRY = "P495";
const P_IMAGE = "P18";

// maxlag returns HTTP 200 with an error body, so the fetcher's 5xx retry never
// sees it. Raised so the driver leaves the brand UNCHECKED — writing a false
// `no_match` would be honoured by the 30-day negative cache.
export class WikimediaUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Wikimedia declined the request (${reason}) — leaving the brand unchecked.`);
    this.name = "WikimediaUnavailableError";
  }
}

export interface WikidataSearchHit {
  id: string;
  label: string | null;
  description: string | null;
}

interface Snak {
  snaktype?: string;
  datavalue?: { value?: unknown; type?: string };
}

interface Statement {
  mainsnak?: Snak;
  rank?: "preferred" | "normal" | "deprecated";
}

export interface WikidataEntity {
  id: string;
  labels?: Record<string, { language?: string; value?: string }>;
  aliases?: Record<string, { language?: string; value?: string }[]>;
  descriptions?: Record<string, { language?: string; value?: string }>;
  claims?: Record<string, Statement[]>;
  sitelinks?: Record<string, { site?: string; title?: string }>;
}

export interface CommonsImage {
  file: string; // "File:Foo.svg" — the Commons title
  downloadUrl: string; // the thumb (preferred) or the original
  mime: string; // the mime of what downloadUrl serves
  descriptionUrl: string; // the file description page — where the credit links
  licenseCode: string;
  licenseName: string;
  licenseUrl: string | null;
  artist: string | null;
  attributionRequired: boolean;
  creditLine: string;
}

export type BrandImageOutcome = "resolved" | "ambiguous" | "no_match" | "no_image" | "blocked";

export interface BrandImageLookup {
  status: BrandImageOutcome;
  qid: string | null;
  entityUrl: string | null;
  commonsFile: string | null;
  candidates: BrandImageCandidate[];
  note: string | null;
  // Set only when status is `resolved` — the licence gate has already passed and
  // the bytes have NOT been fetched.
  image: CommonsImage | null;
}

// --- URLs (exported so a test can assert exactly what was requested) ----------

export function searchUrl(brand: string): string {
  const params = new URLSearchParams({
    action: "wbsearchentities",
    format: "json",
    formatversion: "2",
    type: "item",
    language: "en",
    uselang: "en",
    limit: String(SEARCH_LIMIT),
    search: brand,
    maxlag: "5",
  });
  return `${WIKIDATA_API}?${params.toString()}`;
}

export function entitiesUrl(qids: readonly string[]): string {
  const params = new URLSearchParams({
    action: "wbgetentities",
    format: "json",
    formatversion: "2",
    ids: qids.join("|"),
    props: "labels|aliases|descriptions|claims|sitelinks",
    languages: "en|es",
    maxlag: "5",
  });
  return `${WIKIDATA_API}?${params.toString()}`;
}

export function imageInfoUrl(file: string): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    prop: "imageinfo",
    titles: file.startsWith("File:") ? file : `File:${file}`,
    iiprop: "url|extmetadata|mime|size",
    iiurlwidth: String(THUMB_WIDTH),
    iiextmetadatafilter:
      "License|LicenseShortName|LicenseUrl|UsageTerms|Artist|Attribution|AttributionRequired|Credit|Restrictions|Copyrighted",
    maxlag: "5",
  });
  return `${COMMONS_API}?${params.toString()}`;
}

// --- parsing -----------------------------------------------------------------

function parseJson(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WikimediaUnavailableError("unparseable response");
  }
  if (parsed == null || typeof parsed !== "object") throw new WikimediaUnavailableError("unexpected response");
  const obj = parsed as Record<string, unknown>;
  // maxlag (and other API-level errors) come back 200 with an error object.
  const error = obj.error as { code?: string } | undefined;
  if (error) throw new WikimediaUnavailableError(error.code ?? "api error");
  return obj;
}

export function parseSearch(body: string): WikidataSearchHit[] {
  const obj = parseJson(body);
  const search = Array.isArray(obj.search) ? (obj.search as Record<string, unknown>[]) : [];
  return search
    .filter((hit) => typeof hit.id === "string")
    .map((hit) => ({
      id: hit.id as string,
      label: typeof hit.label === "string" ? hit.label : null,
      description: typeof hit.description === "string" ? hit.description : null,
    }));
}

export function parseEntities(body: string): WikidataEntity[] {
  const obj = parseJson(body);
  const entities = obj.entities;
  if (entities == null || typeof entities !== "object") return [];
  return Object.values(entities as Record<string, WikidataEntity>).filter(
    (entity): entity is WikidataEntity => entity != null && typeof entity.id === "string",
  );
}

// --- matching ----------------------------------------------------------------

// The MATCHING normalization — deliberately not brandSlug(). NFKD plus combining-
// mark stripping folds "Padrón" onto "padron"; plain brandSlug() would give
// "padr-n" and miss. The stored `brand_slug` column stays plain brandSlug(),
// because that is the join key the URL contract resolves through.
export function fold(value: string): string {
  return brandSlug(value.normalize("NFKD").replace(/\p{M}+/gu, ""));
}

function labelOf(entity: WikidataEntity, lang = "en"): string | null {
  return entity.labels?.[lang]?.value ?? null;
}

function descriptionOf(entity: WikidataEntity, lang = "en"): string | null {
  return entity.descriptions?.[lang]?.value ?? null;
}

function aliasesOf(entity: WikidataEntity): string[] {
  const out: string[] = [];
  for (const lang of ["en", "es"]) {
    for (const alias of entity.aliases?.[lang] ?? []) {
      if (alias?.value) out.push(alias.value);
    }
  }
  return out;
}

// Every item-valued QID a property carries, deprecated ranks dropped.
function claimQids(entity: WikidataEntity, property: string): string[] {
  const out: string[] = [];
  for (const statement of entity.claims?.[property] ?? []) {
    if (statement.rank === "deprecated") continue;
    const value = statement.mainsnak?.datavalue?.value;
    if (value != null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
      out.push((value as { id: string }).id);
    }
  }
  return out;
}

function hasAny(values: readonly string[], allow: readonly string[]): boolean {
  if (allow.length === 0) return false;
  const set = new Set(allow);
  return values.some((v) => set.has(v));
}

// The brand's P18, or null. Deprecated ranks are dropped, `preferred` wins, and
// otherwise the first in document order is taken. MULTIPLE P18s on one entity are
// alternative depictions of the SAME brand, not an identity ambiguity — the
// ambiguity rule is about which entity, never which photo.
export function selectImageFile(entity: WikidataEntity): string | null {
  const statements = (entity.claims?.[P_IMAGE] ?? []).filter((s) => s.rank !== "deprecated");
  const ordered = [...statements.filter((s) => s.rank === "preferred"), ...statements.filter((s) => s.rank !== "preferred")];
  for (const statement of ordered) {
    const value = statement.mainsnak?.datavalue?.value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// The properties the disambiguator reads — exported so `--probe` can print them
// with their labels, which is how the taxonomy allowlists get seeded.
export const PROBE_PROPERTIES = [P_INSTANCE_OF, P_SUBCLASS_OF, P_INDUSTRY, P_PRODUCT, P_COUNTRY, P_ORIGIN_COUNTRY] as const;

// Step 1 of qualification on its own: does the entity's label or any en/es alias
// fold onto the brand name exactly? Exported for `--probe`, which reports the
// claims of exactly the entities the real run would consider.
export function nameMatches(brand: string, entity: WikidataEntity): boolean {
  const target = fold(brand);
  const names = [labelOf(entity), ...aliasesOf(entity)].filter((n): n is string => n != null);
  return names.some((n) => fold(n) === target);
}

// Every disambiguating claim of one entity, keyed by property.
export function probeClaims(entity: WikidataEntity): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const property of PROBE_PROPERTIES) out[property] = claimQids(entity, property);
  return out;
}

export function entityLabel(entity: WikidataEntity): string | null {
  return labelOf(entity);
}

export function entityDescription(entity: WikidataEntity): string | null {
  return descriptionOf(entity);
}

export interface QualifiedCandidate extends BrandImageCandidate {
  tier: "A" | "B";
  entity: WikidataEntity;
}

export interface QualifyResult {
  status: "resolved" | "ambiguous" | "no_match";
  chosen: QualifiedCandidate | null;
  candidates: BrandImageCandidate[];
}

// Score is ORDERING ONLY — it never promotes a Tier-B candidate or breaks a tie
// into an automatic answer. Ambiguity is resolved by a human, never by a margin.
function scoreOf(entity: WikidataEntity, tier: "A" | "B", taxonomy: WikidataTaxonomy): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (tier === "A") {
    score += 3;
    reasons.push("tobacco-class claim");
  } else {
    reasons.push("generic brand + tobacco description");
  }
  const description = descriptionOf(entity);
  if (description && TOBACCO_DESCRIPTION.test(description)) {
    score += 1;
    reasons.push("tobacco description");
  }
  if (entity.sitelinks?.enwiki) {
    score += 1;
    reasons.push("en sitelink");
  }
  if (selectImageFile(entity) != null) {
    score += 1;
    reasons.push("has P18");
  }
  const countries = [...claimQids(entity, P_COUNTRY), ...claimQids(entity, P_ORIGIN_COUNTRY)];
  if (hasAny(countries, taxonomy.origin)) {
    score += 1;
    reasons.push("cigar-country origin");
  }
  return { score, reasons };
}

// Qualify the candidate entities for one brand name.
//
// 1. Name gate (necessary, never sufficient): the folded English label, or any
//    en/es alias, must equal the folded brand EXACTLY. No substring, no trigram —
//    "an unqualified name match is a bug", so a name match alone qualifies nothing.
// 2. Negative gate: any P31 in the negative list rejects the candidate outright.
// 3. Tier A (qualifying): direct tobacco-domain evidence in P31/P279/P452/P1056.
// 4. Tier B (supporting, NEVER sufficient): a generic commercial class plus a
//    tobacco word in the description — offered to a curator, never auto-applied.
//
// Exactly one Tier A → resolved. Two or more → ambiguous. Zero Tier A with any
// Tier B → ambiguous. Neither → no_match.
export function qualifyCandidates(
  brand: string,
  entities: readonly WikidataEntity[],
  taxonomy: WikidataTaxonomy = WIKIDATA_TAXONOMY,
): QualifyResult {
  const target = fold(brand);
  const qualified: QualifiedCandidate[] = [];

  for (const entity of entities) {
    const label = labelOf(entity);
    const names = [label, ...aliasesOf(entity)].filter((n): n is string => n != null);
    if (!names.some((n) => fold(n) === target)) continue;

    const instanceOf = claimQids(entity, P_INSTANCE_OF);
    if (hasAny(instanceOf, taxonomy.negative)) continue;

    const subclassOf = claimQids(entity, P_SUBCLASS_OF);
    const tierA =
      hasAny([...instanceOf, ...subclassOf], taxonomy.tobaccoClass) ||
      hasAny(claimQids(entity, P_INDUSTRY), taxonomy.tobaccoIndustry) ||
      hasAny(claimQids(entity, P_PRODUCT), taxonomy.tobaccoProduct);

    const description = descriptionOf(entity);
    const tierB =
      !tierA && hasAny(instanceOf, taxonomy.genericBrand) && description != null && TOBACCO_DESCRIPTION.test(description);

    if (!tierA && !tierB) continue;

    const tier = tierA ? "A" : "B";
    const { score, reasons } = scoreOf(entity, tier, taxonomy);
    qualified.push({
      qid: entity.id,
      label,
      description,
      imageFile: selectImageFile(entity),
      score,
      reasons,
      tier,
      entity,
    });
  }

  qualified.sort((a, b) => b.score - a.score || a.qid.localeCompare(b.qid));
  const candidates: BrandImageCandidate[] = qualified.map(({ qid, label, description, imageFile, score, reasons }) => ({
    qid,
    label,
    description,
    imageFile,
    score,
    reasons,
  }));
  const tierA = qualified.filter((c) => c.tier === "A");

  if (tierA.length === 1) return { status: "resolved", chosen: tierA[0]!, candidates };
  if (qualified.length === 0) return { status: "no_match", chosen: null, candidates };
  return { status: "ambiguous", chosen: null, candidates };
}

// --- Commons: licence gate + credit ------------------------------------------

// extmetadata values are HTML fragments. Strip tags, decode the handful of
// entities MediaWiki emits, collapse whitespace, and cap the length — an Artist
// field can be an entire templated author box.
const MAX_ARTIST_LENGTH = 200;

function plainText(html: string | null | undefined): string | null {
  if (html == null) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return null;
  return text.length > MAX_ARTIST_LENGTH ? `${text.slice(0, MAX_ARTIST_LENGTH - 1)}…` : text;
}

interface ExtMeta {
  [key: string]: { value?: unknown } | undefined;
}

function metaText(meta: ExtMeta, key: string): string | null {
  const raw = meta[key]?.value;
  if (raw == null) return null;
  return plainText(String(raw));
}

export function licenseAllowed(code: string | null): boolean {
  if (code == null) return false;
  return LICENSE_ALLOWLIST.test(code.trim().toLowerCase());
}

// The credit line rendered wherever the image appears. Author fallback chain:
// Attribution → Artist → Credit → "Wikimedia Commons". A public-domain/CC0 file
// carries no author condition, so it reads as the licence alone.
export function buildCreditLine(author: string | null, licenseName: string, attributionRequired: boolean): string {
  if (!attributionRequired || author == null) return licenseName;
  return `${author} · ${licenseName}`;
}

// Parse one imageinfo response into a servable CommonsImage, or a blocked reason.
// The licence is decided HERE, before any byte is requested.
export function parseImageInfo(
  body: string,
  file: string,
): { image: CommonsImage; restrictions: string | null } | { blocked: string } {
  const obj = parseJson(body);
  const query = obj.query as { pages?: unknown } | undefined;
  const pages = Array.isArray(query?.pages) ? (query.pages as Record<string, unknown>[]) : [];
  const page = pages[0];
  const info = Array.isArray(page?.imageinfo) ? (page.imageinfo as Record<string, unknown>[])[0] : undefined;
  if (!info) return { blocked: "no_imageinfo" };

  const meta = (info.extmetadata ?? {}) as ExtMeta;
  const licenseCode = metaText(meta, "License");
  if (!licenseAllowed(licenseCode)) return { blocked: `license:${licenseCode ?? "absent"}` };

  const licenseName = metaText(meta, "LicenseShortName") ?? metaText(meta, "UsageTerms") ?? licenseCode!;
  const author = metaText(meta, "Attribution") ?? metaText(meta, "Artist") ?? metaText(meta, "Credit") ?? "Wikimedia Commons";
  const code = licenseCode!.trim().toLowerCase();
  // extmetadata's own AttributionRequired, when present, wins over the code test.
  const declared = metaText(meta, "AttributionRequired");
  const attributionRequired =
    declared != null ? declared.toLowerCase() !== "false" : !NO_ATTRIBUTION_REQUIRED.test(code);

  // Always prefer the thumb: it is far smaller AND rasterizes SVG, which the
  // image pipeline cannot decode. The original is a fallback only when its own
  // mime is one the pipeline accepts — and it can be tens of megabytes, so this
  // choice narrows the download without bounding it; fetchBinary does that.
  const thumbUrl = typeof info.thumburl === "string" ? info.thumburl : null;
  const thumbMime = typeof info.thumbmime === "string" ? info.thumbmime : "image/png";
  const originalUrl = typeof info.url === "string" ? info.url : null;
  const originalMime = typeof info.mime === "string" ? info.mime : "";
  let downloadUrl: string;
  let mime: string;
  if (thumbUrl != null) {
    downloadUrl = thumbUrl;
    mime = thumbMime;
  } else if (originalUrl != null && ACCEPTED_MEDIA.has(originalMime.toLowerCase())) {
    downloadUrl = originalUrl;
    mime = originalMime;
  } else {
    return { blocked: "unsupported_media" };
  }

  const descriptionUrl =
    typeof info.descriptionurl === "string"
      ? info.descriptionurl
      : `https://commons.wikimedia.org/wiki/${encodeURIComponent(file.startsWith("File:") ? file : `File:${file}`)}`;

  return {
    // `Restrictions` (e.g. `trademarked`) rides back to the caller as a note, not
    // as a blocker: trademark is not copyright, and a brand cover is nominative use.
    restrictions: metaText(meta, "Restrictions"),
    image: {
      file,
      downloadUrl,
      mime,
      descriptionUrl,
      licenseCode: code,
      licenseName,
      licenseUrl: metaText(meta, "LicenseUrl"),
      artist: author,
      attributionRequired,
      creditLine: buildCreditLine(author, licenseName, attributionRequired),
    },
  };
}

// --- the per-brand lookup ----------------------------------------------------

async function fetchJson(fetcher: Fetcher, url: string): Promise<string> {
  const res = await fetcher.fetchText(url);
  if (res.status !== 200) throw new WikimediaUnavailableError(`http ${res.status}`);
  return res.body;
}

// Resolve the licence-cleared image for one already-chosen entity — the path a
// curator's pick takes on the next run. The bytes are still NOT fetched here.
export async function lookupChosenEntity(fetcher: Fetcher, qid: string): Promise<BrandImageLookup> {
  const entities = parseEntities(await fetchJson(fetcher, entitiesUrl([qid])));
  const entity = entities.find((e) => e.id === qid);
  const base: BrandImageLookup = {
    status: "no_match",
    qid,
    entityUrl: `https://www.wikidata.org/wiki/${qid}`,
    commonsFile: null,
    candidates: [],
    note: null,
    image: null,
  };
  if (!entity) return { ...base, note: "entity gone" };
  return withCommonsImage(fetcher, base, entity);
}

// Shared tail: take a qualified entity, pick its P18, run the licence gate.
async function withCommonsImage(
  fetcher: Fetcher,
  base: BrandImageLookup,
  entity: WikidataEntity,
): Promise<BrandImageLookup> {
  const file = selectImageFile(entity);
  if (file == null) return { ...base, status: "no_image", commonsFile: null };

  const body = await fetchJson(fetcher, imageInfoUrl(file));
  const parsed = parseImageInfo(body, file);
  if ("blocked" in parsed) {
    return { ...base, status: "blocked", commonsFile: file, note: parsed.blocked };
  }
  return {
    ...base,
    status: "resolved",
    commonsFile: file,
    note: parsed.restrictions,
    image: parsed.image,
  };
}

// One brand → an outcome. Search, qualify, and (only for a single qualifying
// entity) the licence gate. NOTHING here fetches image bytes: an ambiguous or
// blocked outcome never touches upload.wikimedia.org, which is asserted by test.
export async function resolveBrandImage(
  fetcher: Fetcher,
  brand: string,
  taxonomy: WikidataTaxonomy = WIKIDATA_TAXONOMY,
): Promise<BrandImageLookup> {
  const hits = parseSearch(await fetchJson(fetcher, searchUrl(brand)));
  const empty: BrandImageLookup = {
    status: "no_match",
    qid: null,
    entityUrl: null,
    commonsFile: null,
    candidates: [],
    note: null,
    image: null,
  };
  if (hits.length === 0) return empty;

  const entities = parseEntities(await fetchJson(fetcher, entitiesUrl(hits.map((h) => h.id))));
  const qualified = qualifyCandidates(brand, entities, taxonomy);

  if (qualified.status === "no_match") return { ...empty, candidates: qualified.candidates };
  if (qualified.status === "ambiguous") {
    return { ...empty, status: "ambiguous", candidates: qualified.candidates, note: `${qualified.candidates.length} candidates` };
  }

  const chosen = qualified.chosen!;
  const base: BrandImageLookup = {
    ...empty,
    qid: chosen.qid,
    entityUrl: `https://www.wikidata.org/wiki/${chosen.qid}`,
    candidates: qualified.candidates,
  };
  return withCommonsImage(fetcher, base, chosen.entity);
}

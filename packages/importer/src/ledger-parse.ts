import { parseCsv } from "./csv.js";
import { columnIndex } from "./table.js";
import { parseLegacyDate } from "./dates.js";
import {
  classify,
  parseSize,
  parsePrice,
  normalizeBrand,
  BRAND_DRIFT,
  type ParsedPurchase,
} from "./purchases-parse.js";

// Ledger-snapshot parser (flow 006): the owner's verbatim spreadsheet export
// (`archive/ledger/purchases-*.csv`) → structured purchase rows, reusing the
// archive purchase parser's placeholder/size/price/brand-drift rules so the two
// sources are interpreted identically. Columns match the archive table plus a
// free-text `Aging` column carried verbatim into the purchase's notes.
//
// No-fabrication handling (flow 006 rules) layered on top:
//   - "Rockey Patel" (and the other known aliases) → imported literally, flagged
//     for the curator to merge (never silently renamed).
//   - brand "???" → treated as unknown: brand nulled, cigar created unverified
//     only when a cigar name exists (else nothing is written), flagged.
//   - "Backordered"/"Stuck" in Humidor Data → null + flagged.
//   - "$"-prefixed PPS → numeric string.
//   - blank Vitola/Size (the Cuban half) → null, silently (expected, not flagged).
//   - a present-but-malformed Size (e.g. `6.0" 2 52`) → null + flagged, never guessed.

const UNKNOWN_BRAND = "???";

export interface LedgerRow {
  ordinal: number; // 1-based CSV data-row ordinal (drives the idempotency key)
  purchase: ParsedPurchase;
  reviewNotes: string[]; // curator-facing reasons for the rows we insert
  matchKey: string; // normalized name|date|qty|packaging, for reconciliation
  skipInsert: boolean; // true only for "???" brand with no cigar name → create nothing
}

// The normalization used to line a ledger row up with an existing purchase:
// the same whitespace collapse the importer applies to names, folded to lower
// case so casing drift between the two sources never blocks a match.
export function normalizeMatchPart(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// The reconciliation match key. Name identity is the UNORDERED pair {brand,
// cigar}: the archive purchase table and the raw spreadsheet put the house and
// the mark in opposite columns for the Cuban half ("No 3" / "Ramon Allones" vs
// "Ramon Allones" / "No 3"), so ordered `<brand> <cigar>` would miss them and
// re-insert purchases already imported. Sorting the two normalized values makes
// the whole-column swap a no-op while still requiring both values to line up.
export function matchKey(
  brand: string,
  cigar: string,
  purchasedAt: string | null,
  quantity: number | null,
  packaging: string | null,
): string {
  const name = [normalizeMatchPart(brand), normalizeMatchPart(cigar)].sort().join("\u0001");
  return [name, purchasedAt ?? "", quantity ?? "", normalizeMatchPart(packaging)].join("|");
}

export function parseLedgerCsv(text: string): LedgerRow[] {
  const table = parseCsv(text).filter((r) => r.some((cell) => cell.trim() !== ""));
  if (table.length < 2) return [];
  const headers = table[0]!;
  // Exact header match — "aging" is a substring of "packaging", so the
  // substring-based columnIndex would otherwise resolve Aging to Packaging.
  const exact = (name: string, fallback: number): number => {
    const i = headers.findIndex((h) => h.trim().toLowerCase() === name);
    return i >= 0 ? i : fallback;
  };
  const col = {
    cigar: columnIndex(headers, ["cigar"], 0),
    brand: columnIndex(headers, ["brand"], 1),
    packaging: columnIndex(headers, ["packaging"], 2),
    qty: columnIndex(headers, ["qty", "quantity"], 3),
    vitola: columnIndex(headers, ["vitola"], 4),
    type: columnIndex(headers, ["type"], 5),
    size: columnIndex(headers, ["size"], 6),
    purchaseDate: columnIndex(headers, ["purchase date"], 7),
    humidor: columnIndex(headers, ["humidor"], 8),
    boxDate: columnIndex(headers, ["box date"], 9),
    retailer: columnIndex(headers, ["retailer"], 10),
    pps: columnIndex(headers, ["pps", "price"], 11),
    aging: exact("aging", 12),
  };

  return table.slice(1).map((row, i): LedgerRow => {
    const ordinal = i + 1;
    const cell = (index: number): string => (row[index] ?? "").trim();
    const reviewNotes: string[] = [];

    const cigar = cell(col.cigar);
    const brandRaw = cell(col.brand);

    // Brand quirks. "???" is an explicit unknown (null the brand, flag it); the
    // known aliases stay literal and are flagged for a curator merge.
    const unknownBrand = brandRaw === UNKNOWN_BRAND;
    const brand = unknownBrand ? "" : brandRaw;
    const drift = unknownBrand ? null : (BRAND_DRIFT.get(normalizeBrand(brandRaw)) ?? null);
    const canonicalName = `${brand} ${cigar}`.replace(/\s+/g, " ").trim();

    if (unknownBrand) {
      reviewNotes.push(
        cigar
          ? `brand "???" unknown → cigar created unverified, curator to set brand`
          : `brand "???" and no cigar name → nothing created, curator to supply`,
      );
    }
    if (drift) {
      reviewNotes.push(`brand drift "${brandRaw}" → ${drift}; created literal, curator to merge`);
    }

    // Vitola / Size: blank is expected on the Cuban half (silent null); a flagged
    // placeholder ("Misc") is nulled + noted; a present-but-unparseable size is
    // nulled + noted (never guessed).
    const vitola = classify(cell(col.vitola));
    if (vitola.kind === "flagged")
      reviewNotes.push(`vitola placeholder "${cell(col.vitola)}" → null`);

    const size = classify(cell(col.size));
    if (size.kind === "flagged") reviewNotes.push(`size placeholder "${cell(col.size)}" → null`);
    let lengthInches: number | null = null;
    let ringGauge: number | null = null;
    if (size.value !== null) {
      const parsed = parseSize(size.value);
      if (parsed.lengthInches === null || parsed.ringGauge === null) {
        reviewNotes.push(`malformed size "${size.value}" → null (not guessed)`);
      } else {
        lengthInches = parsed.lengthInches;
        ringGauge = parsed.ringGauge;
      }
    }

    const humidor = classify(cell(col.humidor));
    if (humidor.kind === "flagged") reviewNotes.push(`humidor "${cell(col.humidor)}" → null`);
    const purchaseDate = classify(cell(col.purchaseDate));
    if (purchaseDate.kind === "flagged")
      reviewNotes.push(`purchase date "${cell(col.purchaseDate)}" → null`);
    const boxDate = classify(cell(col.boxDate)); // "-"/blank on NC rows is expected — never flagged
    const retailer = classify(cell(col.retailer));

    const qtyRaw = cell(col.qty);
    const quantity = /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : null;
    const typeRaw = cell(col.type).toUpperCase();
    const type = typeRaw === "NC" || typeRaw === "CC" ? (typeRaw as "NC" | "CC") : null;

    const agingRaw = cell(col.aging);
    const notes = agingRaw.length > 0 ? agingRaw : null;

    const purchasedAt = purchaseDate.value ? parseLegacyDate(purchaseDate.value) : null;
    const packaging = classify(cell(col.packaging)).value;

    const purchase: ParsedPurchase = {
      rowNumber: ordinal,
      cigar,
      brand,
      canonicalName,
      packaging,
      quantity,
      vitola: vitola.value,
      type,
      lengthInches,
      ringGauge,
      purchasedAt,
      humidorAt: humidor.value ? parseLegacyDate(humidor.value) : null,
      boxDate: boxDate.value ? parseLegacyDate(boxDate.value) : null,
      retailer: retailer.value,
      pricePerStick: parsePrice(classify(cell(col.pps)).value),
      notes,
      placeholderNotes: [],
      brandDrift: drift,
    };

    return {
      ordinal,
      purchase,
      reviewNotes,
      matchKey: matchKey(brand, cigar, purchasedAt, quantity, packaging),
      skipInsert: unknownBrand && cigar.length === 0,
    };
  });
}

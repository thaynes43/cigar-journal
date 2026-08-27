import { parseFirstTable, columnIndex } from "./table.js";
import { parseLegacyDate } from "./dates.js";

// Purchase-history rows → structured purchase records (flow 006). Placeholders
// (`TBD`, `Misc`, `Backordered`, `Stuck`) become null + a needs-review note;
// the plain empty marker (`-`) becomes null silently. Brand drift ("LFD",
// "Rockey Patel") is imported under the literal name and flagged — never
// rewritten — leaving the merge to the curation queue.

// Placeholders that signal missing-but-expected data (flagged for review).
const FLAGGED_PLACEHOLDER = new Set(["tbd", "misc", "backordered", "stuck"]);
// The plain empty/not-applicable marker (nulled silently).
const EMPTY_PLACEHOLDER = new Set(["-", ""]);

// Known brand drift (archive-format.md + obvious abbreviations). Detection only
// — the value drives a report note, never a silent rename of the written cigar.
// Exported so the ledger reconciler shares one drift table (flow 006).
export const BRAND_DRIFT = new Map<string, string>([
  ["lfd", "La Flor Dominicana"],
  ["rockey patel", "Rocky Patel"],
  ["hdm", "Hoyo de Monterrey"],
  ["ryj", "Romeo y Julieta"],
  ["cuba", "unknown brand (placeholder)"],
]);

export type PlaceholderKind = "flagged" | "empty" | null;

export interface PurchaseFieldNote {
  field: string;
  raw: string;
}

export interface ParsedPurchase {
  rowNumber: number; // 1-based data-row ordinal (stable idempotency key input)
  cigar: string;
  brand: string;
  canonicalName: string; // `${brand} ${cigar}`
  packaging: string | null;
  quantity: number | null;
  vitola: string | null;
  type: "NC" | "CC" | null;
  lengthInches: number | null;
  ringGauge: number | null;
  purchasedAt: string | null;
  humidorAt: string | null;
  boxDate: string | null;
  retailer: string | null; // vendor name; null when placeholder
  pricePerStick: string | null; // numeric string for the numeric column
  notes: string | null; // free-text carried verbatim (ledger "Aging"); null for the archive table
  placeholderNotes: PurchaseFieldNote[]; // flagged placeholders only
  brandDrift: string | null; // suggested canonical when the brand is a known alias
}

// Placeholder classification, size/price coercion, and brand normalization are
// exported so the ledger reconciler applies the exact same rules (flow 006) —
// one interpretation of the source, never a forked second parser.
export function classify(raw: string): { value: string | null; kind: PlaceholderKind } {
  const s = raw.trim();
  if (EMPTY_PLACEHOLDER.has(s)) return { value: null, kind: "empty" };
  if (FLAGGED_PLACEHOLDER.has(s.toLowerCase())) return { value: null, kind: "flagged" };
  return { value: s, kind: null };
}

export function parseSize(raw: string | null): {
  lengthInches: number | null;
  ringGauge: number | null;
} {
  if (!raw) return { lengthInches: null, ringGauge: null };
  const m = /(\d+(?:\.\d+)?)\s*"?\s*[x×]\s*(\d+)/i.exec(raw);
  if (!m) return { lengthInches: null, ringGauge: null };
  return { lengthInches: Number(m[1]), ringGauge: Number(m[2]) };
}

export function parsePrice(raw: string | null): string | null {
  if (!raw) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(raw.replace(/[$,]/g, ""));
  return m ? m[0] : null;
}

export function normalizeBrand(brand: string): string {
  return brand.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parsePurchaseHistory(markdown: string): ParsedPurchase[] {
  const table = parseFirstTable(markdown);
  if (!table) return [];
  const h = table.headers;
  const col = {
    cigar: columnIndex(h, ["cigar"], 0),
    brand: columnIndex(h, ["brand"], 1),
    packaging: columnIndex(h, ["packaging"], 2),
    qty: columnIndex(h, ["qty", "quantity"], 3),
    vitola: columnIndex(h, ["vitola"], 4),
    type: columnIndex(h, ["type"], 5),
    size: columnIndex(h, ["size"], 6),
    purchaseDate: columnIndex(h, ["purchase date"], 7),
    humidor: columnIndex(h, ["humidor"], 8),
    boxDate: columnIndex(h, ["box date"], 9),
    retailer: columnIndex(h, ["retailer"], 10),
    pps: columnIndex(h, ["pps", "price"], 11),
  };

  return table.rows.map((row, i) => {
    const cell = (index: number): string => (row[index] ?? "").trim();
    const notes: PurchaseFieldNote[] = [];
    const flagField = (field: string, raw: string, kind: PlaceholderKind): void => {
      if (kind === "flagged") notes.push({ field, raw: raw.trim() });
    };

    const cigar = cell(col.cigar);
    const brand = cell(col.brand);

    const vitola = classify(cell(col.vitola));
    flagField("vitola", cell(col.vitola), vitola.kind);
    const size = classify(cell(col.size));
    flagField("size", cell(col.size), size.kind);
    const purchaseDate = classify(cell(col.purchaseDate));
    flagField("purchaseDate", cell(col.purchaseDate), purchaseDate.kind);
    const humidor = classify(cell(col.humidor));
    flagField("humidorAt", cell(col.humidor), humidor.kind);
    const boxDate = classify(cell(col.boxDate));
    // boxDate `-` on NC rows is expected (CC only) — never flagged.
    const retailer = classify(cell(col.retailer));
    const pps = classify(cell(col.pps));

    const qtyRaw = cell(col.qty);
    const quantity = /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : null;
    const typeRaw = cell(col.type).toUpperCase();
    const type = typeRaw === "NC" || typeRaw === "CC" ? (typeRaw as "NC" | "CC") : null;
    const { lengthInches, ringGauge } = parseSize(size.value);

    const drift = BRAND_DRIFT.get(normalizeBrand(brand)) ?? null;

    return {
      rowNumber: i + 1,
      cigar,
      brand,
      canonicalName: `${brand} ${cigar}`.replace(/\s+/g, " ").trim(),
      packaging: classify(cell(col.packaging)).value,
      quantity,
      vitola: vitola.value,
      type,
      lengthInches,
      ringGauge,
      purchasedAt: purchaseDate.value ? parseLegacyDate(purchaseDate.value) : null,
      humidorAt: humidor.value ? parseLegacyDate(humidor.value) : null,
      boxDate: boxDate.value ? parseLegacyDate(boxDate.value) : null,
      retailer: retailer.value,
      pricePerStick: parsePrice(pps.value),
      notes: null, // the archive purchase table has no free-text column
      placeholderNotes: notes,
      brandDrift: drift,
    };
  });
}

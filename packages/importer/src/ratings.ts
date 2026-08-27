import { parseFirstTable, columnIndex } from "./table.js";

// Ratings live in the per-brand index table (archive-format.md). The scale is
// nominally 0–100, but the real data drifts across three scales — bare 0–100
// integers (82, 90, 100), fractions (8/10, 10/10) and decimals (9.3, 8.2) —
// plus placeholders (N/A, -) and typos (8/*10). We accept ONLY an unambiguous
// 0–100 integer and flag everything else for curation rather than guess a scale
// conversion (flow 006: "rating from the brand-index table when present").

export interface RatingParse {
  rating: number | null;
  raw: string;
  // Present in the table but not an accepted 0–100 integer (needs curation).
  ambiguous: boolean;
}

const LINK = /\[[^\]]*\]\(([^)]+)\)/;

// Map each linked review page (filename, e.g. "series-b.md") → its raw Rating
// cell text, keyed off the index table for one brand folder.
export function parseBrandIndexRatings(markdown: string): Map<string, string> {
  const table = parseFirstTable(markdown);
  const out = new Map<string, string>();
  if (!table) return out;
  const ratingCol = columnIndex(table.headers, ["rating"], table.headers.length - 1);
  const cigarCol = columnIndex(table.headers, ["cigar"], 0);
  for (const row of table.rows) {
    const link = LINK.exec(row[cigarCol] ?? "");
    if (!link) continue;
    const file = link[1]!.split("/").pop()!.trim();
    out.set(file, (row[ratingCol] ?? "").trim());
  }
  return out;
}

export function parseRatingCell(raw: string): RatingParse {
  const s = raw.trim();
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) {
    return { rating: null, raw: s, ambiguous: false };
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    // 11–100 is unambiguously the 100-scale. 0–10 collides with the 10-scale
    // the same author also uses (e.g. Padron "10" beside "9/10"), so it is
    // ambiguous, not a low score — flag rather than record a misleading 10/100.
    if (n >= 11 && n <= 100) return { rating: n, raw: s, ambiguous: false };
    return { rating: null, raw: s, ambiguous: true };
  }
  // Fractions (8/10), decimals (9.3), typos (8/*10), out-of-range.
  return { rating: null, raw: s, ambiguous: true };
}

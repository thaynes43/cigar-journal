// Legacy date parsing (archive-format.md): the supported forms are `M/D/YYYY`
// and `YYYY-MM-DD`. A year-less `M/D` (e.g. "10/31", "9/18") cannot become a
// date without guessing the year, so it returns null — the importer never
// fabricates; the caller records a needs-review note and the domain stamps the
// smokedAt as `unknown`.

const MDY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

function toISO(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  // Reject calendar overflow (e.g. 2/30 silently rolling into March).
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Returns a `YYYY-MM-DD` string when parseable, else null.
export function parseLegacyDate(raw: string): string | null {
  const s = raw.trim();
  const mdy = MDY.exec(s);
  if (mdy) return toISO(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  const iso = ISO.exec(s);
  if (iso) return toISO(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  return null;
}

// Strip a trailing embedded date from a page title ("Series B 11/16" → "Series
// B"). Documented normalization for the one page title that embeds a date
// (archive-format.md); the raw title is still preserved as the journal title.
export function stripTrailingDate(title: string): string {
  return title.replace(/\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?$/, "").trim();
}

import type { CigarView } from "@cj/domain";

// How a cigar names itself outside its own heading — the vitals row, the page
// title, the share card. Kept in one place so the three never drift, and
// absent-when-empty throughout: a dimension nobody recorded drops out rather
// than rendering as a placeholder.

export function cigarVitolaLine(cigar: CigarView): string | null {
  const dims =
    cigar.vitola.lengthInches != null && cigar.vitola.ringGauge != null
      ? `${cigar.vitola.lengthInches}" × ${cigar.vitola.ringGauge}`
      : null;
  return [cigar.vitola.name, dims].filter(Boolean).join(" · ") || null;
}

// The share description: the ancestry that tells a reader which cigar this is.
export function cigarShareDescription(cigar: CigarView): string | undefined {
  return [cigar.brand, cigar.line, cigarVitolaLine(cigar)].filter(Boolean).join(" · ") || undefined;
}

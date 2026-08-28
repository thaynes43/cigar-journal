// Descriptors are normalized kebab-case tags for search/analytics; the user's
// verbatim wording is preserved separately (ADR-002). Normalization never
// rejects — a tag that reduces to empty is simply dropped.

const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeDescriptor(raw: string): string | null {
  const kebab = raw
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "") // fold accents onto their base letter
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab.length > 0 ? kebab : null;
}

export function normalizeDescriptors(raw: readonly string[] | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const value of raw) {
    const normalized = normalizeDescriptor(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

// specificDescriptors are the user's exact, unusual words — kept VERBATIM, never
// kebab-cased (ADR-002, tool contract). We only trim surrounding whitespace and
// drop empties/duplicates; casing, spaces, and punctuation survive byte-for-byte
// (e.g. "wet slate", "grandpa's attic" stay exactly as the user said them).
export function verbatimDescriptors(raw: readonly string[] | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const value of raw) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

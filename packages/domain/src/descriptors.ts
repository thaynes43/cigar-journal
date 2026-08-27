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

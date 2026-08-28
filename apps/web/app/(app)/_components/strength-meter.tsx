// The strength meter: assessed strength as a five-step fill over the
// mild→full spectrum. Strength is free text in the domain, so degradation is
// designed, honestly:
//   - text on the five-step vocabulary → filled meter (plus the verbatim word
//     when `showValue`);
//   - any other text → the verbatim text alone, no scale implied;
//   - absent → nothing.

const STEPS = new Map([
  ["mild", 1],
  ["mild-medium", 2],
  ["medium", 3],
  ["medium-full", 4],
  ["full", 5],
]);

// Free text → step on the mild→full scale, or null off-vocabulary. Case and
// separators normalize ("Medium to Full", "medium_full" → medium-full).
export function strengthStep(value: string | null | undefined): number | null {
  if (!value) return null;
  const key = value
    .toLowerCase()
    .replace(/\bto\b/g, "-")
    .replace(/[\s_/–—]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return STEPS.get(key) ?? null;
}

export function StrengthMeter({ value, showValue = false }: { value: string | null; showValue?: boolean }) {
  if (!value) return null;
  const step = strengthStep(value);
  if (step == null) return <span className="text-sm text-ink">{value}</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span role="img" aria-label={value} className="inline-flex items-center gap-[3px]">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`h-[5px] w-3.5 rounded-full ${i <= step ? "bg-accent" : "bg-line"}`} />
        ))}
      </span>
      {showValue ? <span aria-hidden>{value}</span> : null}
    </span>
  );
}

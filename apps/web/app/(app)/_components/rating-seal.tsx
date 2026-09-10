// The 100-point rating as a band-seal mark. Absent rating renders no seal —
// never a placeholder zero, and never a mark for `liked`: the ♥ belongs to the
// catalog-level Favorite alone (owner ruling, 2026-09-10).

const SEAL: Record<"sm" | "md", { box: string; num: string }> = {
  sm: { box: "size-9 border", num: "text-sm" },
  md: { box: "size-14 border-2", num: "text-xl" },
};

export function RatingSeal({
  rating,
  size = "sm",
}: {
  rating: number | null | undefined;
  size?: "sm" | "md";
}) {
  if (rating == null) return null;

  const s = SEAL[size];
  return (
    // `relative` is the inner keyline's containing block: it is inset from the
    // seal's own padding box, so it has to resolve against the bordered element
    // rather than any wrapper around it.
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full border-accent/70 ${s.box}`}
    >
      <span className="absolute inset-0.5 rounded-full border border-accent/30" />
      {/* `tabular-nums` alone does not force lining figures: the display stack's
       * real first hits (Iowan Old Style, Georgia) carry oldstyle figures, so a
       * 3-digit 100 drops below the baseline and clips the inner keyline on the
       * owner's Mac in a way this pod's fallback serif never shows. */}
      <span className={`font-display font-semibold text-accent lining-nums tabular-nums ${s.num}`}>
        {rating}
      </span>
    </span>
  );
}

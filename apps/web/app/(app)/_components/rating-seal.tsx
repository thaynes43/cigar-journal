// The 100-point rating as a band-seal mark. Absent rating renders no seal —
// never a placeholder zero; a liked-only smoke still shows its heart.

const SEAL: Record<"sm" | "md", { box: string; num: string; heart: string }> = {
  sm: { box: "size-9 border", num: "text-sm", heart: "text-xs" },
  md: { box: "size-14 border-2", num: "text-xl", heart: "text-xs" },
};

// `role="img"` so the label is actually announced — an aria-label on a bare
// <span> is not reliably exposed, and the glyph alone reads as punctuation.
function Heart({ className }: { className?: string }) {
  return (
    <span className={`text-ember ${className ?? ""}`} role="img" aria-label="Liked">
      ♥
    </span>
  );
}

export function RatingSeal({
  rating,
  liked,
  size = "sm",
}: {
  rating: number | null | undefined;
  liked?: boolean | null;
  size?: "sm" | "md";
}) {
  if (rating == null) return liked ? <Heart className={SEAL[size].heart} /> : null;

  const s = SEAL[size];
  const seal = (
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

  if (!liked) return seal;

  // At `md` the seal only ever sits on `--bg`, so the heart keeps its overlay and
  // its backing plate matches the ground behind it. At `sm` every caller is a
  // `bg-surface` card (journal card, public journal card, the cigar detail's
  // "Your smokes" row), where that `bg-bg` plate is a mismatched notch cut into
  // the ring — and the overhang pushes a 10px glyph into the card's padding. The
  // heart becomes a sibling instead: the parents are already flex rows with a
  // gap, so it reads as one more mark in the badge row at the row's own size.
  if (size === "sm") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1">
        {seal}
        <Heart className={s.heart} />
      </span>
    );
  }

  return (
    <span className="relative inline-flex shrink-0 items-center justify-center">
      {seal}
      <span className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-bg px-0.5">
        <Heart className={s.heart} />
      </span>
    </span>
  );
}

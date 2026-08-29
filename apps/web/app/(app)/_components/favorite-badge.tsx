// The tile's favorite mark (DESIGN-002) — the second cigar-level mark. Unlike the
// WantBadge (a chip in the tile's cap-three badge row), the favorite rides the
// ART as a small heart in the corner — the same overlay idiom as the photo-strip
// remove button — so it never competes for a badge slot and the two marks stay
// visually distinct. Server-safe (no client boundary), so catalog tiles render it
// inline; the tile shows it only when the caller favorites the cigar. Filled ♥ in
// the ember reserved for hearts.
export function FavoriteBadge() {
  return (
    <span
      aria-label="Favorite"
      className="absolute top-1.5 left-1.5 flex size-6 items-center justify-center rounded-full border border-line bg-bg/80 text-sm leading-none text-ember"
    >
      ♥
    </span>
  );
}

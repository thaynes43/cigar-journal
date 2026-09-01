import { BandTile } from "./band-tile";

// The hero's parchment plate (DESIGN-002 §detail #1): one 3:4 framed box for
// every cigar — the product photo contained on the plate ground, or the
// BandTile filling the identical frame — so the hero's structure never varies
// with photo luck. The geometry echoes the catalog still (the 600×800 photo
// stock is exactly 3:4). `object-contain`, not cover: vendor shots vary in
// ratio and a hero must not crop the cigar; an off-ratio shot letterboxes on
// the plate instead.
export function HeroPlate({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-card border border-line bg-surface">
      {photoUrl ? (
        <img src={photoUrl} alt="" className="h-full w-full object-contain" />
      ) : (
        <BandTile name={name} shape="fill" />
      )}
    </div>
  );
}

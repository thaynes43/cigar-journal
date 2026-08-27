// The 100-point rating as a band-seal mark. Absent rating renders no seal —
// never a placeholder zero; a liked-only smoke still shows its heart.

const SEAL: Record<"sm" | "md", { box: string; num: string; heart: string }> = {
  sm: { box: "size-9 border", num: "text-sm", heart: "text-[0.625rem]" },
  md: { box: "size-14 border-2", num: "text-xl", heart: "text-xs" },
};

function Heart({ className }: { className?: string }) {
  return (
    <span className={`text-ember ${className ?? ""}`} aria-label="Liked">
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
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full border-accent/70 ${s.box}`}>
      <span className="absolute inset-0.5 rounded-full border border-accent/30" />
      <span className={`font-display font-semibold text-accent tabular-nums ${s.num}`}>{rating}</span>
      {liked ? (
        <span className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-bg px-0.5">
          <Heart className={s.heart} />
        </span>
      ) : null}
    </span>
  );
}

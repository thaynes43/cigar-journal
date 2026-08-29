// Shared Tailwind class strings so every form and page reads as one system.
// All color comes from the Humidor token layer in globals.css.
export const ui = {
  label: "flex flex-col gap-1.5 text-sm",
  legend: "label-caps",
  field:
    "rounded-field border border-line bg-bg px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/25",
  chip: "inline-flex items-center gap-1 rounded-chip bg-chip px-2.5 py-0.5 text-xs text-chip-ink",
  chipOutline:
    "inline-flex items-center gap-1 rounded-chip border border-line px-2.5 py-0.5 text-xs text-muted",
  button:
    "rounded-field border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none disabled:opacity-50",
  primary:
    "rounded-field bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50",
  danger:
    "rounded-field border border-danger/40 px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger-wash focus-visible:ring-2 focus-visible:ring-danger/25 focus-visible:outline-none disabled:opacity-50",
  alert: "rounded-field border border-danger/40 bg-danger-wash px-3 py-2 text-sm text-danger",
  muted: "text-muted",
  card: "rounded-card border border-line bg-surface p-5",
} as const;

// The want mark's single control shape (DESIGN-002 WantToggle): chip-shaped,
// accent-filled when set, outlined when unset. The want mark spends the single
// amber accent — that is what the accent is reserved for (meaning), which is why
// want gets no second color. Shared by the interactive toggle (a <button>) and
// its static tile-badge variant (a <span>).
export const wantChip = {
  base: "inline-flex items-center gap-1 rounded-chip px-2.5 py-0.5 text-xs font-medium",
  set: "bg-accent text-accent-ink",
  unset: "border border-line text-muted",
} as const;

// The favorite mark's control shape (DESIGN-002) — the second cigar-level mark.
// Chip-shaped like the WantToggle, but the state signal is the HEART's fill
// (♥ set / ♡ unset) in the warm `ember` reserved for hearts; the single amber
// `accent` stays the want mark's alone. The chip stays outlined in both states
// so the two marks never read as the same control. Used by the interactive
// detail toggle; on tiles the favorite rides the art corner (FavoriteBadge).
export const favoriteChip = {
  base: "inline-flex items-center gap-1 rounded-chip border px-2.5 py-0.5 text-xs font-medium transition-colors",
  set: "border-ember/50 text-ink",
  unset: "border-line text-muted",
  heartSet: "text-ember",
  heartUnset: "text-muted",
} as const;

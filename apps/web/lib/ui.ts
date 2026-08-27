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

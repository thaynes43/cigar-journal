import type { SmokedAt } from "@cj/domain";

const DAY = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });
const MINUTE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Render a Smoked-At honoring precision: day-precision drops the clock. Pure —
// used both server-side and, through <LocalDate>, client-side to show each viewer
// their own timezone without a hydration mismatch.
export function formatSmokedAt(smokedAt: SmokedAt): string | null {
  if (!smokedAt.value) return null;
  const date = new Date(smokedAt.value);
  return smokedAt.precision === "day" ? DAY.format(date) : MINUTE.format(date);
}

export function formatDay(iso: string | null): string | null {
  return iso ? DAY.format(new Date(iso)) : null;
}

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short" });

// A month-and-year stamp, e.g. "Aug 2026" — the inventory tile's aging line.
export function formatMonthYear(iso: string | null): string | null {
  return iso ? MONTH_YEAR.format(new Date(iso)) : null;
}

// Whole months elapsed since an ISO date, e.g. "13 mo" — the ledger aging cell.
export function agingLabel(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const start = new Date(iso);
  const months =
    (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  return `${Math.max(0, months)} mo`;
}

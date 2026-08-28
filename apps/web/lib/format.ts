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

// A price with its currency, e.g. "$12.50" — the market panel's amount. Falls back
// to a plain two-decimal number when the currency code is absent or unrecognized
// (Intl throws on a non-ISO-4217 code).
export function formatPrice(price: number, currency: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(price);
    } catch {
      // Unknown/nonstandard currency code — fall through to a bare amount.
    }
  }
  return price.toFixed(2);
}

const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

// How long ago a market observation was seen, e.g. "yesterday" / "3 weeks ago",
// falling back to a short date past a year. Day-granularity, so it is timezone-
// robust; server-rendered against a stable now, so no hydration skew.
export function formatSeenAt(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const days = Math.round((then.getTime() - now.getTime()) / 86_400_000);
  const abs = Math.abs(days);
  if (abs < 1) return "today";
  if (abs < 7) return RELATIVE.format(days, "day");
  if (abs < 30) return RELATIVE.format(Math.round(days / 7), "week");
  if (abs < 365) return RELATIVE.format(Math.round(days / 30), "month");
  return DAY.format(then);
}

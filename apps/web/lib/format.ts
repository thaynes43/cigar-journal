import type { SmokedAt } from "@cj/domain";

const DAY_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const MINUTE_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};
const MONTH_YEAR_OPTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short" };

const DAY = new Intl.DateTimeFormat("en-US", DAY_OPTS);
const MINUTE = new Intl.DateTimeFormat("en-US", MINUTE_OPTS);
const MONTH_YEAR = new Intl.DateTimeFormat("en-US", MONTH_YEAR_OPTS);

// A stored IANA zone builds a fresh formatter; the un-zoned default (runtime-local)
// reuses the cached one. Dates are not a hot path, so the per-zone allocation is
// cheap and needs no cache.
function fmt(base: Intl.DateTimeFormat, opts: Intl.DateTimeFormatOptions, timeZone?: string) {
  return timeZone ? new Intl.DateTimeFormat("en-US", { ...opts, timeZone }) : base;
}

// Render a Smoked-At honoring precision: day-precision drops the clock. Pure —
// used both server-side and, through <LocalDate>, client-side. A `timeZone` (the
// viewer's stored IANA zone, DESIGN-003 §Settings) formats against it on both
// server and client identically; omitted, it renders in the runtime's own zone.
export function formatSmokedAt(smokedAt: SmokedAt, timeZone?: string): string | null {
  if (!smokedAt.value) return null;
  const date = new Date(smokedAt.value);
  return smokedAt.precision === "day"
    ? fmt(DAY, DAY_OPTS, timeZone).format(date)
    : fmt(MINUTE, MINUTE_OPTS, timeZone).format(date);
}

export function formatDay(iso: string | null, timeZone?: string): string | null {
  return iso ? fmt(DAY, DAY_OPTS, timeZone).format(new Date(iso)) : null;
}

// A month-and-year stamp, e.g. "Aug 2026" — the inventory tile's aging line.
export function formatMonthYear(iso: string | null, timeZone?: string): string | null {
  return iso ? fmt(MONTH_YEAR, MONTH_YEAR_OPTS, timeZone).format(new Date(iso)) : null;
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

// Seen-dates format in UTC, unlike the viewer-facing smoke dates above: a market
// observation is a server-side crawl fact with no viewer-local moment, and fixing
// the zone keeps the date identical on server and client (no hydration skew) and
// stable for every reader. This preserves the timezone-robustness the earlier
// relative-age rendering got from day-granularity epoch math.
const SEEN_MONTH_DAY = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const SEEN_FULL = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

// The as-of date of a market observation: "Aug 12" within the current year,
// "Aug 12, 2025" outside it (DESIGN-002 §Strings, "seen Aug 12 — month + day;
// year when not current"). A relative age ("3 weeks ago") was the earlier
// rendering and is deliberately gone: the staleness rule only means something
// if the date itself stays explicit on a muted row.
//
// Callers supply the "seen"/"first seen" lead-in, so this returns the bare date.
// Day-granularity keeps it timezone-robust, and it is server-rendered against a
// stable now, so there is no hydration skew.
export function formatSeenDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  return then.getUTCFullYear() === now.getUTCFullYear()
    ? SEEN_MONTH_DAY.format(then)
    : SEEN_FULL.format(then);
}

import type { SmokedAt } from "@cj/domain";

const DAY = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });
const MINUTE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

// Render a Smoked-At honoring precision: day-precision drops the clock. Rendered
// only in server components, so there is no client hydration timezone skew.
export function formatSmokedAt(smokedAt: SmokedAt): string | null {
  if (!smokedAt.value) return null;
  const date = new Date(smokedAt.value);
  return smokedAt.precision === "day" ? DAY.format(date) : MINUTE.format(date);
}

export function formatDay(iso: string | null): string | null {
  return iso ? DAY.format(new Date(iso)) : null;
}

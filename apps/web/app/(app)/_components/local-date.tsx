"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SmokedAt } from "@cj/domain";
import { formatSmokedAt, formatDay, formatMonthYear } from "@/lib/format";

type LocalDateProps = {
  className?: string;
  // Rendered on both server and client for a null date (no timezone ambiguity),
  // so it stays stable through hydration. Defaults to nothing.
  fallback?: ReactNode;
} & (
  | { format: "smokedAt"; value: SmokedAt }
  | { format: "day"; value: string | null }
  | { format: "monthYear"; value: string | null }
);

// Viewer-local date display without a hydration mismatch. Server components
// format dates in the server's timezone (UTC); to show each viewer their own
// local date instead, we render nothing until mounted, then swap in the locally
// formatted string. Server and first client pass agree (both empty), so hydration
// is clean — the same client-only derivation edit-smoke-form.tsx uses for its
// timezone-dependent prefill. Formats reuse lib/format.ts, so the rendered shapes
// are identical to their server-side counterparts.
export function LocalDate(props: LocalDateProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const hasValue = props.format === "smokedAt" ? props.value.value != null : props.value != null;
  if (!hasValue) return <>{props.fallback ?? null}</>;

  const text = mounted ? formatValue(props) : null;
  return props.className ? <span className={props.className}>{text}</span> : <>{text}</>;
}

function formatValue(props: LocalDateProps): string | null {
  switch (props.format) {
    case "smokedAt":
      return formatSmokedAt(props.value);
    case "day":
      return formatDay(props.value);
    case "monthYear":
      return formatMonthYear(props.value);
  }
}

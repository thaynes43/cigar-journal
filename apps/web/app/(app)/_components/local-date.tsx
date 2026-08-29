"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SmokedAt } from "@cj/domain";
import { formatSmokedAt, formatDay, formatMonthYear } from "@/lib/format";
import { useViewerTimeZone } from "./timezone-provider";

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

// Viewer-local date display without a hydration mismatch. Two modes, chosen by
// whether the viewer stored a time zone (DESIGN-003 §Settings, via the
// TimezoneProvider):
//   • Stored zone: formatting is deterministic across server and client, so the
//     date renders immediately — server-rendered dates now respect the stored zone
//     rather than falling back to the server's UTC.
//   • No stored zone: fall back to the original issue-120 behavior — render nothing
//     until mounted, then swap in the browser-local string. Server and first client
//     pass agree (both empty), so hydration stays clean.
// Formats reuse lib/format.ts, so the rendered shapes match their server-side
// counterparts exactly.
export function LocalDate(props: LocalDateProps) {
  const timeZone = useViewerTimeZone();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const hasValue = props.format === "smokedAt" ? props.value.value != null : props.value != null;
  if (!hasValue) return <>{props.fallback ?? null}</>;

  const text = timeZone ? formatValue(props, timeZone) : mounted ? formatValue(props) : null;
  return props.className ? <span className={props.className}>{text}</span> : <>{text}</>;
}

function formatValue(props: LocalDateProps, timeZone?: string): string | null {
  switch (props.format) {
    case "smokedAt":
      return formatSmokedAt(props.value, timeZone);
    case "day":
      return formatDay(props.value, timeZone);
    case "monthYear":
      return formatMonthYear(props.value, timeZone);
  }
}

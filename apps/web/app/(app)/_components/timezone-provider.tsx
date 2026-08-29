"use client";

import { createContext, useContext, type ReactNode } from "react";

// The viewer's preferred IANA time zone (DESIGN-003 §Settings), threaded from the
// server-derived setting in the app layout down to every <LocalDate>. A null zone
// means "unset" — dates fall back to the browser-local rendering LocalDate shipped
// with (issue 120). Providing it high in the tree lets server-rendered dates format
// against the stored zone deterministically, without a per-date prop or a
// hydration mismatch (the zone is identical on server and client).
const TimeZoneContext = createContext<string | null>(null);

export function TimezoneProvider({
  timeZone,
  children,
}: {
  timeZone: string | null;
  children: ReactNode;
}) {
  return <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>;
}

export function useViewerTimeZone(): string | null {
  return useContext(TimeZoneContext);
}

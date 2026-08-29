import { notFound } from "next/navigation";
import { getServerCaller } from "@/lib/trpc/server";
import { PublicJournalList } from "../_components/public-journal-list";

// The public journal index (PRD-001 R7, ADR-004; issue #96). Anonymous-readable.
// LAUNCH CONSTRAINT: one public journal, served at /journal. The multi-user /
// per-handle URL question stays on issue #46 — this route does not encode a handle.
// When no public journal exists the page 404s, identically to a nonexistent smoke,
// so the absence of a public journal is not distinguishable from a bad URL.
export default async function PublicJournalPage() {
  const caller = await getServerCaller();
  if (!(await caller.smokes.publicJournalExists())) notFound();
  return <PublicJournalList />;
}

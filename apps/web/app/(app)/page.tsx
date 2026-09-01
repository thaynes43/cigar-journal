import { requireAuth } from "@/lib/require-auth";
import { JournalList } from "./_components/journal-list";

// The journal: the signed-in user's smokes, newest first. Authed-only — the
// public reader's index lives at /journal (issue #96). The list reads through the
// tRPC client so it can keyset-paginate (infinite scroll); see JournalList.
//
// The heading is the document's only <h1>: the wordmark that links here is chrome
// on every page, so without it this route had no top-level heading at all. Named
// for the surface, the same rule the other routes' headings follow (`Catalog`,
// `Settings`, `Catalog review`) and the name DESIGN-002 §IA gives `/`.
export default async function JournalPage() {
  await requireAuth();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Journal</h1>
      <JournalList />
    </div>
  );
}

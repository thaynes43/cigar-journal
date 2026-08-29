import { requireAuth } from "@/lib/require-auth";
import { JournalList } from "./_components/journal-list";

// The journal: the signed-in user's smokes, newest first. Authed-only — the
// public reader's index lives at /journal (issue #96). The list reads through the
// tRPC client so it can keyset-paginate (infinite scroll); see JournalList.
export default async function JournalPage() {
  await requireAuth();
  return <JournalList />;
}

import { JournalList } from "./_components/journal-list";

// The journal: the signed-in user's smokes, newest first. The list reads through
// the tRPC client so it can keyset-paginate (infinite scroll); see JournalList.
export default function JournalPage() {
  return <JournalList />;
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@cj/db";
import { getPrincipal } from "@cj/auth";
import { getConsentView } from "@cj/oauth";
import { ui } from "@/lib/ui";
import { decide } from "./actions";

// Consent screen (flow 003): app name, requested scopes in plain words, approve
// or deny. No blurbs (AGENTS.md). Requires the session that started the flow;
// the transaction must belong to that user.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ txn?: string }>;
}) {
  const { txn } = await searchParams;
  const principal = await getPrincipal(await headers());
  if (!principal) {
    redirect(`/signin?next=${encodeURIComponent(`/oauth/consent?txn=${txn ?? ""}`)}`);
  }

  const view = txn ? await getConsentView(db, txn) : undefined;
  if (!view || view.userId !== principal.userId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-3 p-6">
        <h1 className="font-display text-xl font-semibold text-ink">Authorization request expired</h1>
        <p className="text-sm text-muted">Start the connection again from your client.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 p-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Authorize {view.clientName}</h1>
      <p className="text-sm text-ink">{view.clientName} is requesting access to your cigar journal.</p>
      <ul className="flex flex-col gap-2 text-sm">
        {view.scopes.map((s) => (
          <li key={s.scope} className="rounded-field border border-line bg-surface px-3 py-2 text-ink">
            {s.description}
          </li>
        ))}
      </ul>
      <form className="flex gap-3">
        <input type="hidden" name="txn" value={view.txnId} />
        <button type="submit" formAction={decide.bind(null, "approve")} className={ui.primary}>
          Approve
        </button>
        <button type="submit" formAction={decide.bind(null, "deny")} className={ui.button}>
          Deny
        </button>
      </form>
    </main>
  );
}

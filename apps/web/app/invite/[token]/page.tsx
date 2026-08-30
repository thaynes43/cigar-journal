import { db } from "@cj/db";
import { describeOpenInvite } from "@cj/domain";
import { ui } from "@/lib/ui";
import { RedeemForm } from "./redeem-form";

// The invite redemption page (ADR-010, issue #46). Anonymous by definition — its
// whole audience has no account yet — so it lives outside the authed (app) group
// and is excluded from the edge gate in middleware.ts. The raw token in the path
// IS the authorization; the page reads it only to render the bound address, and
// the server action is the one place a token is actually burned. An unknown,
// spent, revoked, or expired link collapses to one invalid state with no oracle
// about which.
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await describeOpenInvite({ db, now: () => new Date() }, { token });

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-center font-display text-3xl font-semibold tracking-wide text-ink">
        Cigar Journal
      </h1>
      {invite ? (
        <RedeemForm token={token} email={invite.email} />
      ) : (
        <p role="alert" className={ui.alert}>
          This invite link is invalid or has expired.
        </p>
      )}
    </main>
  );
}

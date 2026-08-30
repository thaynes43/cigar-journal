import { ssoEnabled } from "@cj/auth";
import { SignInForm } from "./signin-form";

// The sign-in page. A server component solely so it can read whether Authentik is
// configured — when it is not, the form renders the password path alone, with no
// SSO button and no configuration blurb (ADR-010, fail closed to local sign-in).
// A failed OAuth callback lands back here with ?error=<code>.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const ssoError = Array.isArray(error) ? (error[0] ?? null) : (error ?? null);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-center font-display text-3xl font-semibold tracking-wide text-ink">
        Cigar Journal
      </h1>
      <SignInForm ssoEnabled={ssoEnabled()} ssoError={ssoError} />
    </main>
  );
}

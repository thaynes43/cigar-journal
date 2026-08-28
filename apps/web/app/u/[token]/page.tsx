import { TokenUploader } from "./uploader";

// The single-use photo upload page (ADR-007, issue #44 part 2). Reached from a
// link the MCP add_smoke_photo tool mints and the user opens on their phone. The
// token IS the authorization — this page lives OUTSIDE the authed (app) group and
// carries no session. It deliberately validates nothing on load (no oracle for
// probing tokens): it renders the uploader shell, and the POST is the one place a
// token is checked. Smoke-agnostic by design — the page reveals nothing about the
// smoke it attaches to.
export const dynamic = "force-dynamic";

export default async function PhotoUploadPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center p-6">
      <TokenUploader token={token} />
    </main>
  );
}

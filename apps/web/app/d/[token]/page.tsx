import { PhotoDrop } from "./drop";

// The photo drop page (ADR-014, issue #263). Reached from the link
// `open_photo_drop` mints and the user opens on their phone, once, for the whole
// smoke: every photo of that smoke lands here, before there is a smoke to attach
// it to. The token IS the authorization — this page lives OUTSIDE the authed
// (app) group, carries no session, and is excluded from the edge gate
// (middleware.ts) for exactly that reason.
//
// The shell is `/u/<token>`'s, deliberately: the two anonymous token pages are
// the same page to the person holding the link. Everything else is client-side —
// the drop's state comes from its own API on mount, so this renders nothing about
// the drop and probes no token (a bad one is a 410 the client shows as expired).
export const dynamic = "force-dynamic";

export default async function PhotoDropPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center p-6">
      <PhotoDrop token={token} />
    </main>
  );
}

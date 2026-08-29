import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { getPrincipal } from "@cj/auth";
import { getServerCaller } from "@/lib/trpc/server";
import { SmokeDetail } from "../../_components/smoke-detail";
import { PublicSmokeDetail } from "../../_components/public-smoke-detail";

// One canonical URL per smoke; the content varies by viewer (issue #96). The
// owner sees the full aggregate; everyone else — an authed non-owner or an
// anonymous reader — sees the public, stripped view, but only if the smoke's
// journal is public. A private smoke and a nonexistent id both fall through to the
// same notFound(): the private and public reads each raise NOT_FOUND for a smoke
// they may not return, so the two cases are indistinguishable (no existence leak).
export default async function SmokeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const caller = await getServerCaller();
  const principal = await getPrincipal(await headers());

  // The owner's full view. Only attempt when signed in — smokes.get is authed and
  // would 401 for an anonymous reader rather than fall through to the public read.
  if (principal) {
    try {
      const smoke = await caller.smokes.get({ smokeId: id });
      return <SmokeDetail smoke={smoke} />;
    } catch (error) {
      // Not the caller's smoke: fall through to the public read (it may be a
      // public journal's smoke). Any other error is real and propagates.
      if (!(error instanceof TRPCError && error.code === "NOT_FOUND")) throw error;
    }
  }

  try {
    const smoke = await caller.smokes.getPublic({ smokeId: id });
    return <PublicSmokeDetail smoke={smoke} />;
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }
}

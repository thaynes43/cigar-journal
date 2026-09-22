import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getPrincipal } from "@cj/auth";
import { getServerCaller } from "@/lib/trpc/server";
import { isUnresolvableSmoke } from "@/lib/smoke-lookup";
import { SmokeDetail } from "../../_components/smoke-detail";
import { PublicSmokeDetail } from "../../_components/public-smoke-detail";

// One canonical URL per smoke; the content varies by viewer (issue #96). The
// owner sees the full aggregate; everyone else — an authed non-owner or an
// anonymous reader — sees the public, stripped view, but only if the smoke's
// journal is public. A private smoke, a nonexistent id and a malformed one all
// fall through to the same notFound() (see isUnresolvableSmoke): the private and
// public reads each raise NOT_FOUND for a smoke they may not return, so those
// cases stay indistinguishable (no existence leak). Both exports below resolve
// the smoke the same way, so the card and the page never disagree about who may
// see what.

// The share text for one smoke. The description prefers what the smoke actually
// concluded — the impression — then the first thing recorded during it, then the
// narrative; a smoke that says none of those gets no description rather than a
// manufactured one. Nothing here is a second authorization path: it reads the
// owner's view when the caller owns it and the public view otherwise, exactly as
// the page does, and says nothing at all about a smoke neither read returns.
function shareDescription(parts: (string | null | undefined)[]): string | undefined {
  for (const part of parts) {
    const text = part?.trim();
    if (!text) continue;
    const flat = text.replace(/\s+/g, " ");
    return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
  }
  return undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const caller = await getServerCaller();
  const principal = await getPrincipal(await headers());

  const smoke = await (async () => {
    if (principal) {
      try {
        return await caller.smokes.get({ smokeId: id });
      } catch (error) {
        if (!isUnresolvableSmoke(error)) throw error;
      }
    }
    try {
      return await caller.smokes.getPublic({ smokeId: id });
    } catch (error) {
      if (isUnresolvableSmoke(error)) return null;
      throw error;
    }
  })();

  if (!smoke) return {};
  return {
    title: smoke.cigar.canonicalName,
    description: shareDescription([
      smoke.assessment.impression,
      smoke.progression.find((entry) => entry.verbatim)?.verbatim,
      smoke.journal.narrative,
    ]),
  };
}

// The page. Owner first, then the public read; see the note at the top.
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
      if (!isUnresolvableSmoke(error)) throw error;
    }
  }

  try {
    const smoke = await caller.smokes.getPublic({ smokeId: id });
    return <PublicSmokeDetail smoke={smoke} />;
  } catch (error) {
    if (isUnresolvableSmoke(error)) notFound();
    throw error;
  }
}

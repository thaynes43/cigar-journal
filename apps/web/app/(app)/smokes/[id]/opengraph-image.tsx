import { ImageResponse } from "next/og";
import type { PublicSmokeView } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { isUnresolvableSmoke } from "@/lib/smoke-lookup";
import { formatDay } from "@/lib/format";
import { smokeBurn } from "./share-burn";
import { ShareCard, CARD_HEIGHT, CARD_WIDTH } from "../../../_og/share-card";
import { ogFonts } from "../../../_og/fonts";

// A smoke's share card.
//
// It reads through `smokes.getPublic` — the SAME anonymous read the page serves
// an unauthenticated visitor — because an unfurler is exactly that: a stranger
// with a URL and no cookie. A private smoke, a smoke that does not exist and a
// malformed id all come back the same way (no existence leak), and all three
// render the site's default card rather than an error: a 500 in an unfurler is a
// broken preview, and a card for a private smoke would leak its existence.
//
// The card therefore carries only what the public view carries. Location and
// occasion are private context and are not on PublicSmokeView at all, so a
// public card's meta line is the date alone.

export const alt = "Cigar Journal";
export const size = { width: CARD_WIDTH, height: CARD_HEIGHT };
export const contentType = "image/png";

async function publicSmoke(id: string): Promise<PublicSmokeView | null> {
  try {
    const caller = await getServerCaller();
    return await caller.smokes.getPublic({ smokeId: id });
  } catch (error) {
    if (isUnresolvableSmoke(error)) return null;
    throw error;
  }
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const smoke = await publicSmoke(id);
  const fonts = await ogFonts();

  if (!smoke) {
    return new ImageResponse(
      <ShareCard eyebrow="cigars.haynesnetwork.com" title="Cigar Journal" titleSize={84} burn={null} />,
      { ...size, fonts },
    );
  }

  const name = smoke.cigar.canonicalName;
  const date = formatDay(smoke.smokedAt.value ?? smoke.endedAt?.value ?? null);
  const { burn, markers } = smokeBurn(smoke.progression);

  return new ImageResponse(
    <ShareCard
      eyebrow="CIGAR JOURNAL · SMOKE"
      title={name}
      titleSize={name.length <= 24 ? 72 : 64}
      meta={date ? date.toUpperCase() : null}
      seal={smoke.assessment.rating != null ? { value: String(smoke.assessment.rating) } : null}
      burn={burn}
      markers={markers}
    />,
    { ...size, fonts },
  );
}

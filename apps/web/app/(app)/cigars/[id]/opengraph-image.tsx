import { ImageResponse } from "next/og";
import type { GetCigarResult } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { ShareCard, CARD_HEIGHT, CARD_WIDTH } from "../../../_og/share-card";
import { ogFonts } from "../../../_og/fonts";
import { cigarVitolaLine } from "./share-text";

// A catalog cigar's share card. The cigar is drawn unlit: a catalog entry is an
// object, not a session — nothing here has been smoked.
//
// The catalog is authed (ADR-004), so an anonymous unfurler's read fails and the
// route falls back to the site's default card rather than erroring. That is the
// honest outcome: an unauthenticated stranger may not learn what is in the
// catalog, and a broken image is worse than a generic one.

export const alt = "Cigar Journal";
export const size = { width: CARD_WIDTH, height: CARD_HEIGHT };
export const contentType = "image/png";

async function readCigar(id: string): Promise<GetCigarResult | null> {
  try {
    const caller = await getServerCaller();
    return await caller.cigars.get({ cigarId: id });
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await readCigar(id);
  const fonts = await ogFonts();

  if (!data) {
    return new ImageResponse(
      <ShareCard eyebrow="CIGAR JOURNAL" title="Cigar Journal" titleSize={84} burn={null} />,
      { ...size, fonts },
    );
  }

  const { cigar, scores } = data;
  // The journal's own verdict when there is one, the critics' otherwise — never
  // the two blended, and never a bare number without saying whose it is.
  const score = scores.journal
    ? { value: String(scores.journal.score), label: "Journal" }
    : scores.critics
      ? { value: String(scores.critics.score), label: "Critics" }
      : null;
  const vitola = cigarVitolaLine(cigar);

  return new ImageResponse(
    <ShareCard
      eyebrow="CIGAR JOURNAL · CATALOG"
      title={cigar.canonicalName}
      titleSize={cigar.canonicalName.length <= 24 ? 72 : 64}
      overline={cigar.brand}
      meta={vitola ? vitola.toUpperCase() : null}
      seal={score}
      burn={null}
    />,
    { ...size, fonts },
  );
}

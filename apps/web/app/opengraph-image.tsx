import { ImageResponse } from "next/og";
import { ShareCard, CARD_HEIGHT, CARD_WIDTH } from "./_og/share-card";
import { ogFonts } from "./_og/fonts";

// The site's share card — what every page without one of its own unfurls as.
// The cigar is unlit: nothing is being claimed about a particular smoke.

export const alt = "Cigar Journal";
export const size = { width: CARD_WIDTH, height: CARD_HEIGHT };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    <ShareCard eyebrow="CIGAR JOURNAL" title="Cigar Journal" titleSize={84} burn={null} />,
    { ...size, fonts: await ogFonts() },
  );
}

import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

// Site-wide metadata. `metadataBase` is what makes every relative OG image URL
// (the generated /opengraph-image routes) resolve to an absolute one — without
// it Next emits a warning and unfurlers get a relative src they cannot fetch.
// The title template lets a page set only its own subject: a smoke renders as
// "Liga Privada No. 9 · Cigar Journal".
export const metadata: Metadata = {
  metadataBase: new URL("https://cigars.haynesnetwork.com"),
  title: { default: "Cigar Journal", template: "%s · Cigar Journal" },
  applicationName: "Cigar Journal",
  openGraph: { siteName: "Cigar Journal", type: "website", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

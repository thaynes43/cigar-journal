import { redirect } from "next/navigation";

// The brand page retires to a redirect (DESIGN-004 D-01). `/cigars` is the one
// catalog surface, and a brand is a hierarchy param on it — so this route's job
// is now to forward its slug into that param and get out of the way.
//
// The defect this removes is not cosmetic: the old page was a separate route
// with its own shape, so entering a brand DROPPED every active facet, sort and
// search. As `?brand=<slug>` the same navigation composes with all of them,
// which is the whole point of hierarchy-as-URL-state.
//
// `redirect()` issues a 307 for this GET, preserving the method and leaving no
// stale entry the Back button lands on. Deliberately not a 308: this is a route
// retiring in favour of a param, and a permanent cache entry in every visitor's
// browser is not worth buying for a link shape the app no longer mints.
export default async function BrandPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/cigars?brand=${encodeURIComponent(slug)}`);
}

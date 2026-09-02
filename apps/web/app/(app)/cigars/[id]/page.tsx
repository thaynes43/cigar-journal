import Link from "next/link";
import { notFound } from "next/navigation";
import { TRPCError } from "@trpc/server";
import type { CigarHierarchy, CigarView, GetCigarResult, Tobacco } from "@cj/domain";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { formatPrice, formatSeenDate } from "@/lib/format";
import {
  isPricedOffer,
  offerTiers,
  priceHeadline,
  priceSectionState,
  PACKAGING_NOT_STATED,
} from "@/lib/price-panel";
import { TIER_NOT_STATED, TIER_SINGLE } from "@cj/domain";
import { ui } from "@/lib/ui";
import { Chips } from "../../_components/chips";
import { HeroPlate } from "../../_components/hero-plate";
import { RatingSeal } from "../../_components/rating-seal";
import { StrengthMeter } from "../../_components/strength-meter";
import { VitalsBlock } from "../../_components/vitals-block";
import { WantToggle } from "../../_components/want-toggle";
import { FavoriteToggle } from "../../_components/favorite-toggle";
import { HoldingPanel } from "../../_components/holding-panel";
import { PriceSpark } from "../../_components/price-spark";
import { LocalDate } from "../../_components/local-date";
import { ProductPhotoAdmin } from "../../_components/product-photo-admin";

function vitola(cigar: CigarView): string | null {
  const dims =
    cigar.vitola.lengthInches != null && cigar.vitola.ringGauge != null
      ? `${cigar.vitola.lengthInches}" × ${cigar.vitola.ringGauge}`
      : null;
  return [cigar.vitola.name, dims].filter(Boolean).join(" · ") || null;
}

function origin(part: { country?: string | null; region?: string | null } | null | undefined): string | null {
  if (!part) return null;
  return [part.region, part.country].filter(Boolean).join(", ") || null;
}

function blendLines(tobacco: Tobacco): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const wrapper = origin(tobacco.wrapper);
  const binder = origin(tobacco.binder);
  const filler = (tobacco.filler ?? []).map(origin).filter((v): v is string => Boolean(v));
  if (wrapper) lines.push({ label: "Wrapper", value: wrapper });
  if (binder) lines.push({ label: "Binder", value: binder });
  if (filler.length > 0) lines.push({ label: "Filler", value: filler.join("; ") });
  return lines;
}

// The blend facts table (DESIGN-004 D-08). Filler/binder/wrapper and strength
// come from the LINKED BLEND ROW, which is where ADR-012 homes them — one home
// instead of the same three facts duplicated across every vitola of a blend. The
// cigar's own structured `tobacco` still answers for rows the blend has not been
// enriched with yet, so a freeform row loses nothing while the backfill runs.
//
// Absent-when-empty throughout: a fact nobody has established renders no row at
// all, never a placeholder or an "Unknown".
function blendFacts(
  cigar: CigarView,
  hierarchy: CigarHierarchy,
): { label: string; value: string }[] {
  const blend = hierarchy.blend;
  const fromBlend = [
    blend?.wrapper ? { label: "Wrapper", value: blend.wrapper } : null,
    blend?.binder ? { label: "Binder", value: blend.binder } : null,
    blend?.filler ? { label: "Filler", value: blend.filler } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  // Fall back per-row, not all-or-nothing: a blend that names only its wrapper
  // must not hide a binder the leaf already knows.
  const named = new Set(fromBlend.map((row) => row.label));
  const fromLeaf = (cigar.tobacco ? blendLines(cigar.tobacco) : []).filter(
    (row) => !named.has(row.label),
  );
  const rows = [...fromBlend, ...fromLeaf];

  if (blend?.strength) rows.push({ label: "Strength", value: blend.strength });

  // No blender row EVER renders for a Cuban blend (ADR-013): Habanos credits the
  // marca, not a person, so a blender line there would be an invented fact rather
  // than a missing one. The blend carries no Cuban flag of its own, so the leaf's
  // `type` is the gate — the same signal every other CC/NC rule in the app reads.
  //
  // The gate is POSITIVE (`=== "NC"`), not `!== "CC"`, and the difference is the
  // whole rule: `type` is nullable and the overwhelming majority of production
  // rows are NULL (890 of 977 as this shipped), so `!== "CC"` credited a blender
  // on every untyped row — precisely the rows nobody has established anything
  // about. Absent-when-empty means an unknown type suppresses the row; only a row
  // known to be New World earns it.
  if (cigar.type === "NC" && hierarchy.blenders.length > 0) {
    rows.push({ label: "Blender", value: hierarchy.blenders.map((b) => b.name).join(", ") });
  }
  return rows;
}

// The breadcrumb (DESIGN-004 D-08): the cigar's ancestry, each level linking to
// its drill on the one catalog surface. A level the row does not have is simply
// absent — nothing renders as `Unknown`.
//
// Ancestor links carry the WHOLE chain above them (`?brand=x&line=y`), not just
// their own param. A line slug is unique per brand, not globally, so a bare
// `?line=reserva` can address several marcas' lines at once; a breadcrumb is a
// precise statement about THIS cigar's ancestry and must not widen into that.
function Breadcrumb({ hierarchy }: { hierarchy: CigarHierarchy }) {
  const crumbs: { label: string; href: string }[] = [];
  const chain = new URLSearchParams();
  if (hierarchy.brand) {
    chain.set("brand", hierarchy.brand.slug);
    crumbs.push({ label: hierarchy.brand.name, href: `/cigars?${chain.toString()}` });
  }
  if (hierarchy.line) {
    chain.set("line", hierarchy.line.slug);
    crumbs.push({ label: hierarchy.line.name, href: `/cigars?${chain.toString()}` });
  }
  // The leaf's own crumb, unlinked — it is this page. It reads as the parts the
  // ancestors above have not already said, the same elision the tiles use inside
  // a drill (D-07).
  const leaf = [hierarchy.blend?.name, hierarchy.vitola?.name].filter(Boolean).join(" · ");
  if (crumbs.length === 0 && !leaf) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden>›</span> : null}
          <Link href={crumb.href} className="transition-colors hover:text-ink">
            {crumb.label}
          </Link>
        </span>
      ))}
      {leaf ? (
        <span className="flex items-center gap-1.5">
          {crumbs.length > 0 ? <span aria-hidden>›</span> : null}
          <span className="text-ink">{leaf}</span>
        </span>
      ) : null}
    </nav>
  );
}

// The reserved score slot (DESIGN-004 D-08). It lands with ADR-013 as TWO
// labelled aggregates carrying their sample counts — `Critics 91 · 12 reviews`
// and `Journal 8.6 · 3 smokes` — never one blended number, and never a bare
// score without the population it came from.
//
// Until those observations exist it renders NOTHING. The slot is reserved here
// rather than left to be rediscovered, because the rule it protects is the one
// ADR-013 is strictest about: a single smoke's rating must never be presented as
// a blend-, line- or brand-level number. The tile's rating seal stays exactly
// what it is — the viewer's own per-cigar rating — and this is the only place a
// higher-level score may ever appear.
function ScoreSlot() {
  return null;
}

export default async function CigarDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAuth();
  const isAdmin = principal.role === "admin";
  const { id } = await params;
  const caller = await getServerCaller();

  let data: GetCigarResult;
  try {
    data = await caller.cigars.get({ cigarId: id });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const { cigar, personalProfile, pricing, hasProductPhoto, productPhotoId, wanted, wantNote, favorited, favoriteNote, hierarchy } =
    data;
  const [{ smokes }, offers, offerHistory, priceHistory, holding] = await Promise.all([
    caller.smokes.list({ cigarId: id, limit: 50 }),
    caller.cigars.offers({ cigarId: id }),
    caller.cigars.offerHistory({ cigarId: id }),
    caller.cigars.priceHistory({ cigarId: id }),
    caller.inventory.forCigar({ cigarId: id }),
  ]);
  // Admin-only: the photo's current rights (or null), so the detail page can offer
  // Add/Upload-link vs Replace/Suppress vs Approve without a client round trip.
  const photoState = isAdmin ? await caller.curation.photoState({ cigarId: id }) : null;
  const blend = blendFacts(cigar, hierarchy);

  // Offer staleness (DESIGN-002 §Price, 30d window): the row and its date stay,
  // but the whole row drops to muted. Price history gate: a spark past ≥3
  // observations over ≥2 distinct days, else a first/last-seen text line.
  const now = Date.now();
  const historyDays = new Set(priceHistory.map((p) => p.seenAt.slice(0, 10)));
  // "One row per vendor with a current offer" (DESIGN-002 §Price): both price
  // columns are nullable, and a row carrying neither is not an offer — it used
  // to render as a bare "—" under the Price heading, which reads as a price.
  const pricedOffers = offers.filter(isPricedOffer);
  // The section speaks whenever there is anything true to say about price:
  // current offers, or — when they have all lapsed — the fact that there were
  // some. The whole observation series is the "existed before" signal, so the two
  // cases are distinguishable rather than both collapsing to an absent section.
  const priceSection = priceSectionState(pricedOffers.length, offerHistory.observationCount);
  // One block per packaging tier, vendors inside it (DESIGN-005): the rows arrive
  // in tier order from the domain read, so this only groups them. The headline
  // above the blocks answers the two questions a buyer asks at once — the best
  // per-stick with its packaging, and what a single costs.
  const tiers = offerTiers(pricedOffers);
  const headline = priceHeadline(pricing, tiers);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-5 sm:flex-row sm:gap-6">
        <div className="w-40 shrink-0 sm:w-52">
          <HeroPlate
            photoUrl={hasProductPhoto ? `/api/product-photos/${id}?v=${productPhotoId}` : null}
            name={cigar.canonicalName}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-2xl leading-tight font-semibold text-ink">
              {cigar.canonicalName}
            </h1>
            <Breadcrumb hierarchy={hierarchy} />
            <ScoreSlot />
            {cigar.verification === "unverified" ? (
              <span className={`${ui.chipOutline} self-start`}>unverified</span>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <WantToggle cigarId={cigar.cigarId} initialWanted={wanted} />
              <FavoriteToggle cigarId={cigar.cigarId} initialFavorited={favorited} />
              <Link href={`/smokes/new?cigarId=${cigar.cigarId}`} className={ui.primary}>
                Record a smoke
              </Link>
            </div>
            {wantNote ? (
              <p className="font-serif text-sm leading-relaxed text-muted">{wantNote}</p>
            ) : null}
            {favoriteNote ? (
              <p className="font-serif text-sm leading-relaxed text-muted">{favoriteNote}</p>
            ) : null}
          </div>
          <VitalsBlock
            items={[
              { label: "Brand", value: cigar.brand },
              { label: "Line", value: cigar.line },
              { label: "Edition", value: cigar.edition },
              { label: "Vitola", value: vitola(cigar) },
              { label: "Type", value: cigar.type },
              { label: "Manufacturer", value: cigar.manufacturer },
              { label: "Factory", value: cigar.factory },
              { label: "Country", value: cigar.productionCountry },
              { label: "Released", value: cigar.releaseYear },
            ]}
          />
        </div>
      </header>

      {isAdmin ? (
        <ProductPhotoAdmin cigarId={cigar.cigarId} initialRights={photoState?.rights ?? null} />
      ) : null}

      {cigar.blendNotes || blend.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="label-caps">Blend</h2>
          {cigar.blendNotes ? (
            <p className="font-serif text-[0.9375rem] leading-relaxed text-ink">{cigar.blendNotes}</p>
          ) : null}
          <VitalsBlock items={blend} />
        </section>
      ) : null}

      {priceSection !== "absent" ? (
        <section className="flex flex-col gap-3">
          <h2 className="label-caps">Price</h2>
          {priceSection === "lapsed" ? (
            <p className="text-sm text-muted">No current offers.</p>
          ) : (
            <div className="flex flex-col gap-5">
              {headline ? (
                <p className="text-sm tabular-nums">
                  <span className="text-ink">{headline.lead}</span>
                  {headline.singles ? (
                    <span className="text-muted">{` — ${headline.singles}`}</span>
                  ) : null}
                </p>
              ) : null}
              {tiers.map((tier) => (
                <div key={tier.label} className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-4 border-b border-line pb-1">
                    <h3 className="text-sm font-semibold text-ink">{tier.label}</h3>
                    {tier.bestPerStick != null ? (
                      <span className="text-sm tabular-nums text-ink">
                        {formatPrice(tier.bestPerStick, tier.currency)} /stick
                      </span>
                    ) : null}
                  </div>
                  <ul className="flex flex-col gap-2">
                    {tier.offers.map((offer) => {
                      // A registry vendor crawled for depth but not a purchase
                      // destination (ADR-006, e.g. Cuban Lou's) is shown as plain,
                      // labeled text — no link-out (below) and an "unapproved
                      // source" tag here.
                      const noLinkout = offer.isRegistryVendor && !offer.purchaseLinkout;
                      // The tier heading carries the packaging, so a row states
                      // what the heading does not: its package price (every tier
                      // but Single, where the package IS the stick), and — in the
                      // Not stated block — the words DESIGN-005 rule 1 requires.
                      const notStated = tier.order === TIER_NOT_STATED;
                      const meta = [
                        offer.isRegistryVendor ? null : "community source",
                        noLinkout ? "unapproved source" : null,
                        notStated ? PACKAGING_NOT_STATED : null,
                        !notStated && tier.order !== TIER_SINGLE && offer.price != null
                          ? formatPrice(offer.price, offer.currency)
                          : null,
                        offer.inStock === true ? "in stock" : null,
                        offer.inStock === false ? "out of stock" : null,
                        `seen ${formatSeenDate(offer.seenAt)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      // At the right: a Not stated row's package price (the only
                      // figure it honestly has), or a vendor's own per-stick when
                      // it differs from the tier's best — the row that is dearer
                      // than the heading says so on its own line.
                      const amount = notStated
                        ? offer.price != null
                          ? formatPrice(offer.price, offer.currency)
                          : null
                        : offer.pricePerStick != null && offer.pricePerStick !== tier.bestPerStick
                          ? formatPrice(offer.pricePerStick, offer.currency)
                          : null;
                      // Stale rows (seen > 30 days ago) keep their date but the
                      // whole row drops to muted (DESIGN-002 §Price staleness rule).
                      const stale = now - new Date(offer.seenAt).getTime() > 30 * 24 * 60 * 60 * 1000;
                      const inner = (
                        <>
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className={`truncate text-sm ${stale ? "text-muted" : "text-ink"}`}>
                              {offer.vendor}
                            </span>
                            <span className="label-caps text-muted">{meta}</span>
                          </div>
                          {amount ? (
                            <span
                              className={`text-sm tabular-nums ${stale ? "text-muted" : "text-ink"}`}
                            >
                              {amount}
                            </span>
                          ) : null}
                        </>
                      );
                      return (
                        <li key={`${offer.vendor}·${offer.packaging ?? ""}`}>
                          {offer.listingUrl && !noLinkout ? (
                            <a
                              href={offer.listingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-4 rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent/60"
                            >
                              {inner}
                            </a>
                          ) : (
                            <div className="flex items-center gap-4 rounded-card border border-line bg-surface p-4">
                              {inner}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {priceHistory.length >= 3 && historyDays.size >= 2 ? (
            <PriceSpark points={priceHistory} />
          ) : priceHistory.length >= 2 ? (
            <p className="label-caps text-muted">
              first seen {formatSeenDate(priceHistory[0]!.seenAt)} · last seen{" "}
              {formatSeenDate(priceHistory[priceHistory.length - 1]!.seenAt)}
            </p>
          ) : priceHistory.length === 1 ? (
            <p className="label-caps text-muted">seen {formatSeenDate(priceHistory[0]!.seenAt)}</p>
          ) : null}
        </section>
      ) : null}

      {holding.hasHolding ? <HoldingPanel holding={holding} /> : null}

      {personalProfile ? (
        <section className="flex flex-col gap-4 rounded-card border border-accent/30 bg-surface p-5">
          <h2 className="label-caps text-accent">Your history</h2>
          {personalProfile.recurringDescriptors.length > 0 ? (
            <Chips items={personalProfile.recurringDescriptors.slice(0, 3)} />
          ) : null}
          <VitalsBlock
            items={[
              { label: "Smokes", value: personalProfile.smokeCount },
              {
                label: "Rating",
                value: personalProfile.rating
                  ? `${personalProfile.rating.average} (${personalProfile.rating.min}–${personalProfile.rating.max})`
                  : null,
              },
              {
                label: "Strength",
                value: personalProfile.typicalStrength ? (
                  <StrengthMeter value={personalProfile.typicalStrength} showValue />
                ) : null,
              },
              {
                label: "Last smoked",
                value: personalProfile.lastSmokedAt ? (
                  <LocalDate format="day" value={personalProfile.lastSmokedAt} />
                ) : null,
              },
            ]}
          />
        </section>
      ) : null}

      {smokes.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="label-caps">Your smokes</h2>
          <ul className="flex flex-col gap-3">
            {smokes.map((smoke) => {
              return (
                <li key={smoke.smokeId}>
                  <Link
                    href={`/smokes/${smoke.smokeId}`}
                    className="flex items-center gap-4 rounded-card border border-line bg-surface p-4 transition-colors hover:border-accent/60"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <LocalDate
                          format="smokedAt"
                          value={smoke.smokedAt}
                          className="label-caps"
                          fallback="—"
                        />
                        {smoke.fromHumidor ? <span className={ui.chipOutline}>humidor</span> : null}
                      </div>
                      <Chips items={smoke.descriptors.slice(0, 4)} />
                    </div>
                    <RatingSeal rating={smoke.rating} liked={smoke.liked} size="sm" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

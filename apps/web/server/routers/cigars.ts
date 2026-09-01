import { z } from "zod";
import {
  searchCigars,
  getCigar,
  getCigarOffers,
  getCigarOfferHistory,
  getCigarPriceHistory,
  browseCigars,
  setWant,
  setFavorite,
} from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// Catalog reads plus the want mark. `search` and `get` are scoped to the caller
// because their results fold in the caller's own history (per-match smoke count;
// the Personal Profile and want overlay on detail). `browse` and `offers` are
// catalog/market-only — auth-gated but principal-free, since market data is
// identical for every viewer.
export const cigarsRouter = router({
  browse: authedProcedure.query(({ ctx }) => browseCigars(ctx.deps)),

  search: authedProcedure
    .input(z.object({ query: z.string(), limit: z.number().optional() }))
    .query(({ ctx, input }) => searchCigars(ctx.deps, ctx.principal, input)),

  get: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getCigar(ctx.deps, ctx.principal, input)),

  offers: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getCigarOffers(ctx.deps, input)),

  // The whole observation series in summary — span, per-stick range, count
  // (ADR-009). It is the "offers existed before" signal DESIGN-002 §Price splits
  // its two no-offer cases on: an absent section for a seeded cigar nothing ever
  // priced, `No current offers.` once something did. `priceHistory` cannot answer
  // that — it counts only observations carrying a per-stick figure, so a cigar
  // whose offers were all package-only reads as never-offered. Catalog/market-
  // only, like `offers`.
  offerHistory: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getCigarOfferHistory(ctx.deps, input)),

  // The cigar's per-stick price observations over time — the detail page's
  // price-history line (DESIGN-002 §Price). Catalog/market-only, like `offers`.
  priceHistory: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getCigarPriceHistory(ctx.deps, input)),

  // The single want mark (PRD-003 R-WANT). Idempotent set/clear; provenance is
  // stamped `manual` — the web is the manual writer, a client can't spoof it. No
  // input field for the note in v1 (owner's default), so the web never sends one.
  setWant: authedProcedure
    .input(z.object({ cigarId: z.string(), wanted: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setWant(ctx.deps, ctx.principal, { ...input, provenance: { source: "manual" } }),
    ),

  // The single favorite mark (PRD-003, DESIGN-002) — the second cigar-level mark,
  // mirroring setWant. Idempotent set/clear; provenance stamped `manual`. No note
  // input field in v1, so the web never sends one.
  setFavorite: authedProcedure
    .input(z.object({ cigarId: z.string(), favorited: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setFavorite(ctx.deps, ctx.principal, { ...input, provenance: { source: "manual" } }),
    ),
});

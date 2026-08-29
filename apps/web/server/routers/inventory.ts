import { z } from "zod";
import { getMyInventory, getHoldingForCigar } from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// The caller's humidor holdings — a read surface over the purchases ledger.
export const inventoryRouter = router({
  list: authedProcedure.query(({ ctx }) => getMyInventory(ctx.deps, ctx.principal)),

  // The holding for one resolved cigar — the record/edit forms read it to gate
  // and default the "From my humidor" control and offer lot attribution (ADR-008).
  forCigar: authedProcedure
    .input(z.object({ cigarId: z.string() }))
    .query(({ ctx, input }) => getHoldingForCigar(ctx.deps, ctx.principal, input.cigarId)),
});

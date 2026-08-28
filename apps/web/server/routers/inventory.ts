import { getMyInventory } from "@cj/domain";
import { router, authedProcedure } from "../trpc";

// The caller's humidor holdings — a read surface over the purchases ledger.
export const inventoryRouter = router({
  list: authedProcedure.query(({ ctx }) => getMyInventory(ctx.deps, ctx.principal)),
});

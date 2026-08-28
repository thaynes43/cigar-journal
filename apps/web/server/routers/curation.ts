import { z } from "zod";
import { curationQueue, mergeCigars, verifyCigar } from "@cj/domain";
import { router, adminProcedure } from "../trpc";

// Catalog curation (ADR-006), curator-only. `adminProcedure` gates the surface;
// the domain services re-check the role. `merge` and `verify` carry the ADR-003
// mutation envelope (clientRequestId) so a double-submit is idempotent.
export const curationRouter = router({
  queue: adminProcedure.query(({ ctx }) => curationQueue(ctx.deps, ctx.principal)),

  merge: adminProcedure
    .input(
      z.object({
        clientRequestId: z.string(),
        sourceCigarId: z.string(),
        targetCigarId: z.string(),
      }),
    )
    .mutation(({ ctx, input }) => mergeCigars(ctx.deps, ctx.principal, input)),

  verify: adminProcedure
    .input(z.object({ clientRequestId: z.string(), cigarId: z.string() }))
    .mutation(({ ctx, input }) => verifyCigar(ctx.deps, ctx.principal, input)),
});

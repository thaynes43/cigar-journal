import { z } from "zod";
import { createInvite, listInvites, revokeInvite } from "@cj/domain";
import { router, adminProcedure } from "../trpc";

// Invite-gated registration (ADR-010, issue #46), admin-only. `adminProcedure`
// gates the surface; the domain services re-check the role. `create` returns the
// raw link token exactly once — it is not recoverable afterwards — and the client
// builds the absolute /invite/<token> URL, the same shape as the product-photo
// upload link. Nothing here carries a role: an invite has no role to grant.
export const invitesRouter = router({
  list: adminProcedure.query(({ ctx }) => listInvites(ctx.deps, ctx.principal)),

  create: adminProcedure
    .input(z.object({ email: z.string() }))
    .mutation(({ ctx, input }) => createInvite(ctx.deps, ctx.principal, input)),

  revoke: adminProcedure
    .input(z.object({ inviteId: z.string().uuid() }))
    .mutation(({ ctx, input }) => revokeInvite(ctx.deps, ctx.principal, input)),
});

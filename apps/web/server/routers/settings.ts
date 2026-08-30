import { z } from "zod";
import { getUserSettings, updateUserSettings } from "@cj/domain";
import { listSignInMethods } from "@cj/auth";
import { router, authedProcedure } from "../trpc";

// The self-serve account settings surface (DESIGN-003 §Settings). `authedProcedure`
// is the whole authorization: identity is server-derived and every read/write is
// scoped to the caller's own row, so there is no principal-free path — an
// anonymous request never reaches `update` (it is rejected UNAUTHORIZED), which is
// what keeps journal visibility un-flippable by anyone but the account's owner.
// The update is a target-state write; each omitted key leaves that section
// untouched, so a section form PATCHes just its own fields. Provenance is stamped
// `manual` — the web is the manual writer, a client can't spoof it.
export const settingsRouter = router({
  get: authedProcedure.query(({ ctx }) => getUserSettings(ctx.deps, ctx.principal)),

  // The caller's linked identities, for the Sign-in section (ADR-010). Scoped to
  // the session's own user id — there is no target-user parameter to abuse.
  signInMethods: authedProcedure.query(({ ctx }) =>
    listSignInMethods(ctx.deps.db, ctx.principal.userId),
  ),

  update: authedProcedure
    .input(
      z.object({
        displayName: z.string().nullable().optional(),
        journalVisibility: z.enum(["public", "private"]).optional(),
        timezone: z.string().nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      updateUserSettings(ctx.deps, ctx.principal, { ...input, provenance: { source: "manual" } }),
    ),
});

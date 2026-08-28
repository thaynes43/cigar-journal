import { initTRPC, TRPCError } from "@trpc/server";
import { DomainError, type ErrorCode, type Deps, type Principal } from "@cj/domain";

// tRPC is the web's inbound adapter over @cj/domain (ADR-001). The context
// carries the domain Deps and the session-derived Principal (ADR-004); a request
// never supplies its own identity.
export interface Context {
  deps: Deps;
  principal: Principal | null;
}

type TRPCErrorCode = ConstructorParameters<typeof TRPCError>[0]["code"];

// Domain typed errors → tRPC codes. The machine-readable domain payload (code,
// fields, candidates, version numbers) rides along on `data.domain` via the
// error formatter below, so the UI self-corrects without re-deriving anything.
const DOMAIN_TO_TRPC: Record<ErrorCode, TRPCErrorCode> = {
  validation_error: "BAD_REQUEST",
  unauthenticated: "UNAUTHORIZED",
  unauthorized: "FORBIDDEN",
  cigar_not_found: "NOT_FOUND",
  cigar_ambiguous: "CONFLICT",
  smoke_not_found: "NOT_FOUND",
  photo_not_found: "NOT_FOUND",
  photo_limit: "CONFLICT",
  version_conflict: "CONFLICT",
  idempotency_conflict: "CONFLICT",
  unavailable: "INTERNAL_SERVER_ERROR",
};

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const domain = error.cause instanceof DomainError ? error.cause.toPayload() : null;
    return { ...shape, data: { ...shape.data, domain } };
  },
});

// Re-map a DomainError (surfaced as the INTERNAL_SERVER_ERROR cause) onto its
// proper tRPC code while preserving the original as `cause` for the formatter.
const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof DomainError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: DOMAIN_TO_TRPC[cause.code], message: cause.message, cause });
  }
  return result;
});

const baseProcedure = t.procedure.use(mapDomainErrors);

export const router = t.router;
export const publicProcedure = baseProcedure;

// Rejects the unauthenticated with UNAUTHORIZED and narrows the Principal to
// non-null for downstream resolvers.
export const authedProcedure = baseProcedure.use(({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

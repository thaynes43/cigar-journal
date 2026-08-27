import type { TRPCClientErrorLike } from "@trpc/client";
import type { ErrorPayload } from "@cj/domain";
import type { AppRouter } from "@/server/routers/_app";

// The domain payload the error formatter attaches (machine-readable code, plus
// fields / candidates / version numbers) — the UI self-corrects from this.
export function domainErrorOf(error: TRPCClientErrorLike<AppRouter> | null | undefined): ErrorPayload | null {
  const data = error?.data as { domain?: ErrorPayload } | null | undefined;
  return data?.domain ?? null;
}

// Field messages from a validation_error, for surfacing next to a form.
export function fieldMessages(error: TRPCClientErrorLike<AppRouter> | null | undefined): string[] {
  const domain = domainErrorOf(error);
  if (domain?.code !== "validation_error") return [];
  const fields = (domain as { fields?: { path: string; message: string }[] }).fields ?? [];
  return fields.map((f) => f.message);
}

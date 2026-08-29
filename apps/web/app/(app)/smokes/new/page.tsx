import { TRPCError } from "@trpc/server";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { NewSmokeForm } from "../../_components/new-smoke-form";

// `?cigarId=` pre-resolves the picker (the detail page's "Record a smoke" action,
// PRD-002 R-INV-3). We fetch the cigar's canonical name server-side so the picker
// opens on it; an unknown id simply falls through to an empty picker.
export default async function NewSmokePage({
  searchParams,
}: {
  searchParams: Promise<{ cigarId?: string }>;
}) {
  await requireAuth();
  const { cigarId } = await searchParams;
  let initialCigar: { cigarId: string; canonicalName: string } | null = null;
  if (cigarId) {
    try {
      const caller = await getServerCaller();
      const { cigar } = await caller.cigars.get({ cigarId });
      initialCigar = { cigarId: cigar.cigarId, canonicalName: cigar.canonicalName };
    } catch (error) {
      if (!(error instanceof TRPCError && error.code === "NOT_FOUND")) throw error;
    }
  }
  return <NewSmokeForm initialCigar={initialCigar} />;
}

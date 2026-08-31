import { notFound } from "next/navigation";
import { getServerCaller } from "@/lib/trpc/server";
import { requireAuth } from "@/lib/require-auth";
import { isUnresolvableSmoke } from "@/lib/smoke-lookup";
import { EditSmokeForm } from "../../../_components/edit-smoke-form";

export default async function EditSmokePage({ params }: { params: Promise<{ id: string }> }) {
  await requireAuth();
  const { id } = await params;
  const caller = await getServerCaller();

  try {
    const smoke = await caller.smokes.get({ smokeId: id });
    return <EditSmokeForm smoke={smoke} />;
  } catch (error) {
    if (isUnresolvableSmoke(error)) notFound();
    throw error;
  }
}

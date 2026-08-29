import { requireAuth } from "@/lib/require-auth";
import { getServerCaller } from "@/lib/trpc/server";
import { SettingsForm } from "./settings-form";

// The self-serve account settings surface (DESIGN-003 §Settings), reached from the
// account menu. Authed-only — requireAuth bounces the anonymous to /signin, and the
// settings.get/update procedures are authedProcedure, so identity is the whole
// authorization (a viewer only ever reads and writes their own account). It owns a
// reading measure now the shell runs full bleed (DESIGN-003 §Layout).
export default async function SettingsPage() {
  await requireAuth();
  const caller = await getServerCaller();
  const settings = await caller.settings.get();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
      <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
      <SettingsForm initial={settings} />
    </div>
  );
}

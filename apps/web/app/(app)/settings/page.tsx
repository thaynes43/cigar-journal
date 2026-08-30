import { requireAuth } from "@/lib/require-auth";
import { getServerCaller } from "@/lib/trpc/server";
import { SettingsForm } from "./settings-form";

// The self-serve account settings surface (DESIGN-003 §Settings), reached from the
// account menu. Authed-only — requireAuth bounces the anonymous to /signin, and the
// settings.get/update procedures are authedProcedure, so identity is the whole
// authorization (a viewer only ever reads and writes their own account). It owns a
// reading measure now the shell runs full bleed (DESIGN-003 §Layout).
export default async function SettingsPage() {
  const principal = await requireAuth();
  const caller = await getServerCaller();
  const settings = await caller.settings.get();
  // Invites are admin-only (ADR-010) — a `user` is not sent the rows at all, the
  // same shape as the user menu's admin-only Catalog review entry.
  const invites = principal.role === "admin" ? await caller.invites.list() : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-10">
      <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
      <SettingsForm initial={settings} invites={invites} />
    </div>
  );
}

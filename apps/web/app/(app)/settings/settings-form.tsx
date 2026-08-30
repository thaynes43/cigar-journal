"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { InviteView, JournalVisibility, UserSettings } from "@cj/domain";
import type { SignInMethod } from "@cj/auth";
import { api } from "@/lib/trpc/react";
import { authClient } from "@/lib/auth-client";
import { ui } from "@/lib/ui";
import { SignInSection } from "./signin-section";
import { InvitesSection } from "./invites-section";

// The self-serve account settings form (DESIGN-003 §Settings): Profile (display
// name), Journal (visibility), Time (zone), Sign-in (linked identities), plus
// admin-only Invites (ADR-010). Each section owns its own mutation so its wait
// state is isolated, PATCHes only its field, and re-reads on success via
// router.refresh() — which also re-renders the layout, so a zone change re-formats
// every date immediately. Every control follows the wait-state rule (DESIGN-002):
// it dims and swaps to a busy label while the round-trip is in flight.
export function SettingsForm({
  initial,
  signInMethods,
  ssoEnabled,
  invites,
}: {
  initial: UserSettings;
  signInMethods: SignInMethod[];
  ssoEnabled: boolean;
  // Null for a non-admin: the section is absent, not disabled.
  invites: InviteView[] | null;
}) {
  return (
    <div className="flex flex-col gap-10">
      <ProfileSection initialName={initial.displayName} />
      <JournalSection initialVisibility={initial.journalVisibility} />
      <TimeSection initialTimezone={initial.timezone} />
      <SignInSection initial={signInMethods} ssoEnabled={ssoEnabled} />
      {invites ? <InvitesSection initial={invites} /> : null}
    </div>
  );
}

function ProfileSection({ initialName }: { initialName: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  // The last value the server confirmed. Save is inert until the field differs
  // from it, so a completed save leaves the button disabled rather than looking
  // like a no-op that can be pressed again.
  const [saved, setSaved] = useState(initialName ?? "");
  const [notice, setNotice] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
  const update = api.settings.update.useMutation({
    onSuccess: async (settings) => {
      const confirmed = settings.displayName ?? "";
      setSaved(confirmed);
      setName(confirmed);
      setNotice({ kind: "saved", text: "Saved." });
      // The app shell reads the viewer (and so the header initial) from Better
      // Auth's session cookie cache, which is good for five minutes. Re-read the
      // session with the cache bypassed so the cookie is re-issued with the new
      // name BEFORE the refresh re-renders the shell; otherwise the header keeps
      // the old name and the save looks like it did nothing.
      await authClient.getSession({ query: { disableCookieCache: true } }).catch(() => undefined);
      router.refresh();
    },
    onError: (error) => setNotice({ kind: "error", text: error.message || "Saving failed." }),
  });
  const dirty = name.trim() !== saved;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || update.isPending) return;
    setNotice(null);
    update.mutate({ displayName: name });
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="label-caps">Profile</h2>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className={ui.label}>
          <span className={ui.legend}>Display name</span>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNotice(null);
            }}
            className={ui.field}
            autoComplete="name"
          />
        </label>
        <button
          type="submit"
          disabled={update.isPending || !dirty}
          className={`${ui.primary} self-start`}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
        {notice ? (
          notice.kind === "error" ? (
            <p role="alert" className={ui.alert}>
              {notice.text}
            </p>
          ) : (
            <p role="status" className={`text-sm ${ui.muted}`}>
              {notice.text}
            </p>
          )
        ) : null}
      </form>
    </section>
  );
}

function JournalSection({ initialVisibility }: { initialVisibility: JournalVisibility }) {
  const router = useRouter();
  const [visibility, setVisibility] = useState(initialVisibility);
  const update = api.settings.update.useMutation({ onSuccess: () => router.refresh() });

  const choose = (next: JournalVisibility) => {
    if (next === visibility) return;
    setVisibility(next); // optimistic
    update.mutate(
      { journalVisibility: next },
      { onError: () => setVisibility(next === "public" ? "private" : "public") },
    );
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="label-caps">Journal</h2>
      <div className="flex items-center gap-3">
        <div
          role="group"
          aria-label="Journal visibility"
          className="inline-flex shrink-0 overflow-hidden rounded-field border border-line"
        >
          {(["public", "private"] as const).map((option) => {
            const active = visibility === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                disabled={update.isPending}
                onClick={() => choose(option)}
                className={`label-caps whitespace-nowrap px-3 py-1.5 transition-colors disabled:opacity-50 ${
                  active ? "bg-accent text-accent-ink" : "text-muted hover:text-ink"
                }`}
              >
                {option === "public" ? "Public" : "Private"}
              </button>
            );
          })}
        </div>
        {update.isPending ? <span className="label-caps text-muted">Saving…</span> : null}
      </div>
    </section>
  );
}

function TimeSection({ initialTimezone }: { initialTimezone: string | null }) {
  const router = useRouter();
  const [timezone, setTimezone] = useState(initialTimezone ?? "");
  const update = api.settings.update.useMutation({ onSuccess: () => router.refresh() });

  // The full IANA set the runtime knows; "" is the automatic (browser-local) zone.
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [] as string[];
    }
  }, []);

  const choose = (next: string) => {
    setTimezone(next);
    update.mutate({ timezone: next === "" ? null : next });
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="label-caps">Time</h2>
      <label className={ui.label}>
        <span className={ui.legend}>Time zone</span>
        <select
          value={timezone}
          disabled={update.isPending}
          onChange={(event) => choose(event.target.value)}
          className={`${ui.field} disabled:opacity-50`}
        >
          <option value="">Automatic</option>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      {update.isPending ? <span className="label-caps text-muted">Saving…</span> : null}
    </section>
  );
}

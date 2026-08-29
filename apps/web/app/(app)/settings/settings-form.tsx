"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { JournalVisibility, UserSettings } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// The self-serve account settings form (DESIGN-003 §Settings): Profile (display
// name), Journal (visibility), Time (zone). Each section owns its own mutation so
// its wait state is isolated, PATCHes only its field, and re-reads on success via
// router.refresh() — which also re-renders the layout, so a zone change re-formats
// every date immediately. Every control follows the wait-state rule (DESIGN-002):
// it dims and swaps to a busy label while the round-trip is in flight.
export function SettingsForm({ initial }: { initial: UserSettings }) {
  return (
    <div className="flex flex-col gap-10">
      <ProfileSection initialName={initial.displayName} />
      <JournalSection initialVisibility={initial.journalVisibility} />
      <TimeSection initialTimezone={initial.timezone} />
    </div>
  );
}

function ProfileSection({ initialName }: { initialName: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const update = api.settings.update.useMutation({ onSuccess: () => router.refresh() });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
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
            onChange={(event) => setName(event.target.value)}
            className={ui.field}
            autoComplete="name"
          />
        </label>
        <button type="submit" disabled={update.isPending} className={`${ui.primary} self-start`}>
          {update.isPending ? "Saving…" : "Save"}
        </button>
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

"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SmokeView } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { fieldMessages, domainErrorOf } from "@/lib/trpc/error";
import { SmokeDetailsFields } from "./smoke-details-fields";
import { ProgressionEditor, type ProgressionDraft } from "./progression-editor";
import { ProgressionTimeline } from "./progression-timeline";
import { detailsFromView, buildUpdateChanges, type SmokeDetailsDraft } from "./smoke-draft";

export function EditSmokeForm({ smoke }: { smoke: SmokeView }) {
  const router = useRouter();
  // Derive the draft on the client only: the smoked-at prefill depends on the
  // viewer's timezone, so computing it during SSR would mismatch on hydration.
  const initial = useRef<SmokeDetailsDraft | null>(null);
  const [details, setDetails] = useState<SmokeDetailsDraft | null>(null);
  const [appended, setAppended] = useState<ProgressionDraft[]>([]);
  const requestId = useRef(crypto.randomUUID());

  useEffect(() => {
    const draft = detailsFromView(smoke);
    initial.current = draft;
    setDetails(draft);
  }, [smoke]);

  const update = api.smokes.update.useMutation({
    onSuccess: () => router.push(`/smokes/${smoke.smokeId}`),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!details || !initial.current) return;
    const changes = buildUpdateChanges(details, initial.current, appended);
    update.mutate({
      clientRequestId: requestId.current,
      smokeId: smoke.smokeId,
      expectedVersion: smoke.version,
      changes,
    });
  }

  const conflict = domainErrorOf(update.error)?.code === "version_conflict";
  const messages = fieldMessages(update.error);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">Edit smoke</h1>
      <p className="font-medium">{smoke.cigar.canonicalName}</p>

      {details ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <SmokeDetailsFields value={details} onChange={setDetails} />

          {smoke.progression.length > 0 ? (
            <section className="flex flex-col gap-2">
              <span className={ui.legend}>Progression</span>
              <ProgressionTimeline entries={smoke.progression} />
            </section>
          ) : null}

          <section className="flex flex-col gap-2">
            <span className={ui.legend}>Add progression</span>
            <ProgressionEditor value={appended} onChange={setAppended} />
          </section>

          {conflict ? (
            <div className={ui.alert}>
              This smoke changed since you opened it. Reload to edit the latest.
              <button type="button" onClick={() => window.location.reload()} className={`${ui.button} ml-3`}>
                Reload
              </button>
            </div>
          ) : messages.length > 0 ? (
            <ul className={ui.alert}>
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : update.error ? (
            <p className={ui.alert}>{update.error.message}</p>
          ) : null}

          <div className="flex gap-3">
            <button type="submit" disabled={update.isPending} className={ui.primary}>
              Save changes
            </button>
            <button type="button" onClick={() => router.push(`/smokes/${smoke.smokeId}`)} className={ui.button}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

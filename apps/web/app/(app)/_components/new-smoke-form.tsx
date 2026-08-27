"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CigarRef } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { fieldMessages } from "@/lib/trpc/error";
import { CigarPicker } from "./cigar-picker";
import { SmokeDetailsFields } from "./smoke-details-fields";
import { ProgressionEditor, type ProgressionDraft } from "./progression-editor";
import { emptyDetails, buildSaveInput, type SmokeDetailsDraft } from "./smoke-draft";

export function NewSmokeForm() {
  const router = useRouter();
  const [cigar, setCigar] = useState<CigarRef | null>(null);
  const [details, setDetails] = useState<SmokeDetailsDraft>(emptyDetails);
  const [progression, setProgression] = useState<ProgressionDraft[]>([]);
  // One request id per intent, so a retried submit is an idempotent replay.
  const requestId = useRef(crypto.randomUUID());

  const save = api.smokes.save.useMutation({
    onSuccess: (result) => router.push(`/smokes/${result.smoke.smokeId}`),
  });

  const [cigarMissing, setCigarMissing] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cigar) {
      setCigarMissing(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setCigarMissing(false);
    save.mutate(buildSaveInput(requestId.current, cigar, details, progression));
  }

  const messages = fieldMessages(save.error);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <h1 className="text-lg font-semibold">Record a smoke</h1>

      <section className="flex flex-col gap-2">
        <span className={ui.legend}>Cigar</span>
        <CigarPicker
          onChange={(ref) => {
            setCigar(ref);
            if (ref) setCigarMissing(false);
          }}
        />
        {cigarMissing ? <p className={ui.alert}>Pick or add the cigar first.</p> : null}
      </section>

      <SmokeDetailsFields value={details} onChange={setDetails} />

      <section className="flex flex-col gap-2">
        <span className={ui.legend}>Progression</span>
        <ProgressionEditor value={progression} onChange={setProgression} />
      </section>

      {messages.length > 0 ? (
        <ul className={ui.alert}>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : save.error ? (
        <p className={ui.alert}>{save.error.message}</p>
      ) : null}

      <div className="flex gap-3">
        <button type="submit" disabled={save.isPending} className={ui.primary}>
          Save
        </button>
        <button type="button" onClick={() => router.push("/")} className={ui.button}>
          Cancel
        </button>
      </div>
    </form>
  );
}

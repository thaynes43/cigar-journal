"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CigarRef } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";
import { fieldMessages } from "@/lib/trpc/error";
import { CigarPicker } from "./cigar-picker";
import { SmokeDetailsFields } from "./smoke-details-fields";
import { ProgressionEditor, type ProgressionDraft } from "./progression-editor";
import { ConsumptionControl, type ConsumptionDraft } from "./consumption-control";
import { emptyDetails, buildSaveInput, type SmokeDetailsDraft } from "./smoke-draft";

// `initialCigar` pre-resolves the picker from the /smokes/new?cigarId= deep link
// (the detail page's record action). Resolving it here means the "From my humidor"
// default engages by itself once the holding read returns — no extra param needed.
export function NewSmokeForm({
  initialCigar,
}: {
  initialCigar?: { cigarId: string; canonicalName: string } | null;
}) {
  const router = useRouter();
  const [cigar, setCigar] = useState<CigarRef | null>(
    initialCigar ? { cigarId: initialCigar.cigarId } : null,
  );
  const [details, setDetails] = useState<SmokeDetailsDraft>(emptyDetails);
  const [progression, setProgression] = useState<ProgressionDraft[]>([]);
  // One request id per intent, so a retried submit is an idempotent replay.
  const requestId = useRef(crypto.randomUUID());

  // A resolved cigar id lets us read its holding: whether to show "From my
  // humidor" and default it on (remaining > 0). A described (unresolved) cigar
  // has no holding yet, so the control never shows (ADR-008 / DESIGN-002).
  const cigarId = cigar && "cigarId" in cigar ? cigar.cigarId : null;
  const holdingQuery = api.inventory.forCigar.useQuery(
    { cigarId: cigarId ?? "" },
    { enabled: Boolean(cigarId) },
  );
  const holding = cigarId ? holdingQuery.data : undefined;
  const [consumption, setConsumption] = useState<ConsumptionDraft>({
    fromHumidor: false,
    purchaseId: null,
  });
  // Default on when there is stock; reset whenever the resolved holding changes.
  useEffect(() => {
    setConsumption(
      holding?.hasHolding
        ? { fromHumidor: holding.remaining > 0, purchaseId: null }
        : { fromHumidor: false, purchaseId: null },
    );
  }, [holding?.cigarId, holding?.hasHolding, holding?.remaining]);

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
    save.mutate(
      buildSaveInput(
        requestId.current,
        cigar,
        details,
        progression,
        holding?.hasHolding ? consumption : null,
      ),
    );
  }

  const messages = fieldMessages(save.error);

  return (
    <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Record a smoke</h1>

      <section className={`${ui.card} flex flex-col gap-3`}>
        <span className={ui.legend}>Cigar</span>
        <CigarPicker
          initial={initialCigar}
          onChange={(ref) => {
            setCigar(ref);
            if (ref) setCigarMissing(false);
          }}
        />
        {cigarMissing ? <p className={ui.alert}>Pick or add the cigar first.</p> : null}
      </section>

      <ConsumptionControl holding={holding} value={consumption} onChange={setConsumption} />

      <section className={`${ui.card}`}>
        <SmokeDetailsFields value={details} onChange={setDetails} />
      </section>

      <section className={`${ui.card} flex flex-col gap-3`}>
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

"use client";

import { useRef, useState } from "react";
import { ui } from "@/lib/ui";
import { MAX_UPLOAD_LABEL } from "@/lib/upload-limits";

// What each failure actually was, in the user's terms. A single "Upload failed."
// for every case told someone holding a 40MB video the same thing it told
// someone whose link had expired — one of them could have fixed it in a second
// and had no way to know. The route names the failure; this is the only place
// that turns a name into words.
//
// Every number here comes from the thing that enforced it — the byte ceiling
// from the constant the route checks, the photo count from the domain error's
// own payload — so no message can outlive the rule it describes. The type list
// is the pipeline's ACCEPTED set (@cj/photos), minus the HEIF spelling of HEIC.
const GENERIC_ERROR = "Upload failed — try again.";
const PHOTO_LIMIT_FALLBACK = 12; // @cj/domain MAX_PHOTOS_PER_SMOKE

function messageFor(code: string | undefined, limit: number | undefined): string {
  switch (code) {
    case "photo_limit":
      return `Photo limit reached — this smoke already has ${limit ?? PHOTO_LIMIT_FALLBACK}.`;
    case "too_large":
      return `That photo is over the ${MAX_UPLOAD_LABEL} limit.`;
    case "unsupported_type":
      return "That file type isn't supported — use a JPEG, PNG, HEIC, or WebP photo.";
    case "upload_token_invalid":
      return "This link has expired or was already used. Ask for a new one in chat.";
    default:
      return GENERIC_ERROR;
  }
}

// One tile, mobile-first: tap to open the camera roll (no `capture`, so it is the
// gallery by default), and upload starts on selection. On success the tile swaps
// to a local preview and "Added."; on failure a single-line message and the tile
// stays live — the route validates the file before it spends the link, so a
// retry after a rejected file genuinely works. Copy is intentionally minimal
// (ADR-007, issue #44).
export function TokenUploader({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [target, setTarget] = useState<{ href: string; label: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setState("pending");
    setMessage(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/photo-uploads/${token}`, { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; limit?: number };
        } | null;
        setMessage(messageFor(body?.error?.code, body?.error?.limit));
        setState("error");
        return;
      }
      // The response is discriminated by what the token attached to: a smoke view
      // carries `smokeId`; a product attach carries `cigarId`.
      const view = (await res.json().catch(() => null)) as {
        smokeId?: string;
        cigarId?: string;
      } | null;
      setTarget(
        view?.smokeId
          ? { href: `/smokes/${view.smokeId}`, label: "Open the smoke" }
          : view?.cigarId
            ? { href: `/cigars/${view.cigarId}`, label: "Open the cigar" }
            : null,
      );
      setPreview(URL.createObjectURL(file));
      setState("done");
    } catch {
      setMessage(GENERIC_ERROR);
      setState("error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (state === "done") {
    return (
      <div className={`${ui.card} flex flex-col items-center gap-3`}>
        {preview ? (
          <img src={preview} alt="" className="aspect-square w-44 rounded-card object-cover" />
        ) : null}
        <p className="text-sm text-ink">Added.</p>
        {target ? (
          <a href={target.href} className={ui.button}>
            {target.label}
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`${ui.card} flex flex-col items-center gap-4`}>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={state === "pending"}
        aria-busy={state === "pending"}
        className={`flex aspect-square w-44 flex-col items-center justify-center gap-1 rounded-card border border-dashed border-line text-muted transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none ${state === "pending" ? "animate-pulse" : ""}`}
      >
        {state === "pending" ? (
          <span className="label-caps">Uploading…</span>
        ) : (
          <>
            <span aria-hidden className="text-2xl leading-none">
              +
            </span>
            <span className="label-caps">Add photo</span>
          </>
        )}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {message ? (
        <p role="alert" className={ui.alert}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { ui } from "@/lib/ui";

// One tile, mobile-first: tap to open the camera roll (no `capture`, so it is the
// gallery by default), and upload starts on selection. On success the tile swaps
// to a local preview and "Added."; on failure a single-line message. Copy is
// intentionally minimal (ADR-007, issue #44).
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
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage(typeof body?.error === "string" ? body.error : "Upload failed.");
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
      setMessage("Upload failed.");
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

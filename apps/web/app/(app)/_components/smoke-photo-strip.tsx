"use client";

import { useRef, useState } from "react";
import type { SmokePhotoView } from "@cj/domain";
import { ui } from "@/lib/ui";

// The smoke's photos, with one-tap add (owner feedback, issue #49 lineage:
// no fields, no form). The tile opens the picker directly; upload starts on
// selection and the strip updates in place — photos are instant attachments,
// deliberately outside the edit form and its Save button. Kind and caption
// stay agent vocabulary (MCP add_smoke_photo); the web sends kind "other".
export function SmokePhotoStrip({
  smokeId,
  photos: initial,
  canAdd,
}: {
  smokeId: string;
  photos: SmokePhotoView[];
  canAdd: boolean;
}) {
  const [photos, setPhotos] = useState<SmokePhotoView[]>(initial);
  const [pending, setPending] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (photos.length === 0 && !canAdd) return null;

  async function upload(file: File) {
    setPending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("smokeId", smokeId);
      const res = await fetch("/api/photos", { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string | { message?: string };
        } | null;
        const message =
          typeof body?.error === "string" ? body.error : body?.error?.message;
        setError(message ?? "Upload failed.");
        return;
      }
      const view = (await res.json()) as SmokePhotoView;
      setPhotos((prev) => [...prev, view]);
    } catch {
      setError("Upload failed.");
    } finally {
      setPending(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(photoId: string) {
    setError(null);
    setRemovingId(photoId);
    try {
      const res = await fetch(`/api/photos/${photoId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        setError("Could not remove the photo.");
        return;
      }
      setPhotos((prev) => prev.filter((p) => p.photoId !== photoId));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {photos.map((photo) => (
          <div
            key={photo.photoId}
            aria-busy={removingId === photo.photoId}
            className={`relative aspect-square overflow-hidden rounded-card border border-line transition-opacity ${removingId === photo.photoId ? "opacity-50" : ""}`}
          >
            <a
              href={`/api/photos/${photo.photoId}`}
              target="_blank"
              rel="noreferrer"
              title={photo.caption ?? undefined}
            >
              <img
                src={`/api/photos/${photo.photoId}/thumb`}
                alt={photo.caption ?? photo.kind}
                className="size-full object-cover"
              />
            </a>
            {canAdd ? (
              <button
                type="button"
                aria-label="Remove photo"
                onClick={() => remove(photo.photoId)}
                disabled={removingId === photo.photoId}
                className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full border border-line bg-bg/80 text-sm leading-none text-muted transition-colors hover:text-danger disabled:opacity-50"
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {canAdd ? (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={pending}
            aria-busy={pending}
            className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-card border border-dashed border-line text-muted transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none ${pending ? "animate-pulse" : ""}`}
          >
            {pending ? (
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
        ) : null}
      </div>
      {canAdd ? (
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
      ) : null}
      {error ? <p className={ui.alert}>{error}</p> : null}
    </div>
  );
}

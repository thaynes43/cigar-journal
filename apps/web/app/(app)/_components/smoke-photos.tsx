"use client";

import { useRef, useState } from "react";
import type { SmokePhotoView, SmokePhotoKind } from "@cj/domain";
import { ui } from "@/lib/ui";

const KINDS: readonly SmokePhotoKind[] = ["cigar", "band", "construction", "burn", "other"];

// Photo management for the edit form: existing photos as thumbs with a Remove
// button, plus an add control that POSTs multipart to /api/photos. The list is
// kept in local state so adds/removes reflect immediately without a full-page
// refresh that would reset the details form mid-edit. Deletion is audit-logged,
// so no confirm step (ADR-007 / house style).
export function SmokePhotos({ smokeId, photos: initial }: { smokeId: string; photos: SmokePhotoView[] }) {
  const [photos, setPhotos] = useState<SmokePhotoView[]>(initial);
  const [kind, setKind] = useState<SmokePhotoKind>("other");
  const [caption, setCaption] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function messageOf(body: unknown): string | null {
    if (body && typeof body === "object" && "error" in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === "string") return err;
      if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
    }
    return null;
  }

  async function add() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose an image first.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("smokeId", smokeId);
      form.set("kind", kind);
      if (caption.trim().length > 0) form.set("caption", caption.trim());

      const res = await fetch("/api/photos", { method: "POST", body: form });
      if (!res.ok) {
        setError(messageOf(await res.json().catch(() => null)) ?? "Upload failed.");
        return;
      }
      const view = (await res.json()) as SmokePhotoView;
      setPhotos((prev) => [...prev, view]);
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
    } catch {
      setError("Upload failed.");
    } finally {
      setPending(false);
    }
  }

  async function remove(photoId: string) {
    setError(null);
    const res = await fetch(`/api/photos/${photoId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      setError(messageOf(await res.json().catch(() => null)) ?? "Could not remove the photo.");
      return;
    }
    setPhotos((prev) => prev.filter((p) => p.photoId !== photoId));
  }

  return (
    <section className={`${ui.card} flex flex-col gap-4`}>
      <span className={ui.legend}>Photos</span>

      {photos.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo) => (
            <div
              key={photo.photoId}
              className="relative aspect-square overflow-hidden rounded-card border border-line"
            >
              <img
                src={`/api/photos/${photo.photoId}/thumb`}
                alt={photo.caption ?? photo.kind}
                title={photo.caption ?? undefined}
                className="size-full object-cover"
              />
              <button
                type="button"
                onClick={() => remove(photo.photoId)}
                className="absolute top-1 right-1 rounded-field border border-line bg-surface px-1.5 py-0.5 text-xs font-medium text-danger"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className={ui.label}>
          <span className={ui.legend}>Image</span>
          <input ref={fileRef} type="file" accept="image/*" className={ui.field} />
        </label>
        <label className={ui.label}>
          <span className={ui.legend}>Kind</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as SmokePhotoKind)}
            className={ui.field}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className={`${ui.label} flex-1`}>
          <span className={ui.legend}>Caption</span>
          <input value={caption} onChange={(event) => setCaption(event.target.value)} className={ui.field} />
        </label>
        <button type="button" onClick={add} disabled={pending} className={ui.button}>
          Add photo
        </button>
      </div>

      {error ? <p className={ui.alert}>{error}</p> : null}
    </section>
  );
}

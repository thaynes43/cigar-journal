"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PhotoDropPhotoView, PhotoDropView, SmokePhotoKind } from "@cj/domain";
import { filterChip, ui } from "@/lib/ui";
import { PHOTO_KINDS, PHOTO_KIND_LABEL } from "@/lib/photo-kinds";
import { GENERIC_UPLOAD_ERROR, messageFor } from "@/lib/upload-messages";

// The drop's whole surface (ADR-014, issue #263): one tile, and whatever the
// link is already holding. A live smoke produces several photos over hours, so
// this page is opened again and again — which is why it shows its contents at
// all, where the single-use `/u` page shows only the tile.
//
// The failure vocabulary is `/u`'s, shared in lib/upload-messages.ts; only the
// photo-limit sentence differs, because a drop has no smoke yet to say "already
// has N" about.
const photoLimitMessage = (limit: number) =>
  `Photo limit reached — ${limit} is the most one smoke can hold.`;

// What the page can be. `loading` renders nothing rather than a shell that might
// flip to "expired" a moment later; the other three are the states the API
// distinguishes (200 / 410 / 503).
type Phase = "loading" | "ready" | "closed" | "unavailable";

// Only the fields this page renders — not the whole PhotoDropView. The optimistic
// value is what an unreadable state read falls back to: `/u` validates nothing on
// load and lets the POST be the one check, and a drop whose state we could not
// read is better off offering the tile than refusing a photo the POST would have
// taken.
type DropState = Pick<PhotoDropView, "status" | "smokeId" | "photos">;
const OPTIMISTIC: DropState = { status: "open", smokeId: null, photos: [] };

// The photo's own caption, on the drop page because that is where the user is
// when the photo is worth a line (#288). One box, no label and no Save: it
// commits on blur and on Enter, and an empty box clears it. The stored value is
// the source of truth — a PATCH response or a refresh replaces what is in the
// box — and `sent` is what stops an untouched field from posting on every blur.
function Caption({
  photo,
  disabled,
  onCommit,
}: {
  photo: PhotoDropPhotoView;
  disabled: boolean;
  onCommit: (caption: string) => void;
}) {
  const stored = photo.caption ?? "";
  const [value, setValue] = useState(stored);
  const sent = useRef(stored);

  useEffect(() => {
    setValue(stored);
    sent.current = stored;
  }, [stored]);

  function commit() {
    const next = value.trim();
    if (next === sent.current) return;
    sent.current = next;
    onCommit(next);
  }

  return (
    <input
      type="text"
      value={value}
      disabled={disabled}
      placeholder="Caption"
      aria-label="Caption"
      // The route's own bound, restated so the box cannot take a caption the
      // PATCH would reject and the refresh would silently discard.
      maxLength={200}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        commit();
      }}
      className={`${ui.field} w-full`}
    />
  );
}

export function PhotoDrop({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [drop, setDrop] = useState<DropState>(OPTIMISTIC);
  const [pending, setPending] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The state read, which is also how the page recovers: any write that comes
  // back wrong re-reads rather than inventing a sentence about it, so a photo
  // someone removed from another tab simply leaves the list.
  const refresh = useCallback(async () => {
    const res = await fetch(`/api/photo-drops/${token}`).catch(() => null);
    if (res?.status === 410) {
      setPhase("closed");
      return;
    }
    if (res?.status === 503) {
      setPhase("unavailable");
      return;
    }
    const view = res?.ok ? ((await res.json().catch(() => null)) as PhotoDropView | null) : null;
    if (view) setDrop({ status: view.status, smokeId: view.smokeId, photos: view.photos });
    setPhase("ready");
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function upload(file: File) {
    setPending(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/photo-drops/${token}`, { method: "POST", body: form });
      if (res.status === 410) {
        setPhase("closed");
        return;
      }
      if (res.status === 503) {
        setPhase("unavailable");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { code?: string; limit?: number };
        } | null;
        setMessage(messageFor(body?.error?.code, body?.error?.limit, photoLimitMessage));
        return;
      }
      const photo = (await res.json()) as PhotoDropPhotoView;
      setDrop((state) => ({ ...state, photos: [...state.photos, photo] }));
    } catch {
      setMessage(GENERIC_UPLOAD_ERROR);
    } finally {
      setPending(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // One PATCH, whichever field the user touched: a chip tap sends `kind`, a
  // caption sends `caption`, and the field left out is left alone.
  async function patch(photoId: string, body: { kind?: SmokePhotoKind; caption?: string }) {
    setBusyId(photoId);
    setMessage(null);
    try {
      const res = await fetch(`/api/photo-drops/${token}/photos/${photoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 410) {
        setPhase("closed");
        return;
      }
      if (!res.ok) {
        await refresh();
        return;
      }
      const photo = (await res.json()) as PhotoDropPhotoView;
      setDrop((state) => ({
        ...state,
        photos: state.photos.map((p) => (p.photoId === photo.photoId ? photo : p)),
      }));
    } catch {
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(photoId: string) {
    setBusyId(photoId);
    setMessage(null);
    try {
      const res = await fetch(`/api/photo-drops/${token}/photos/${photoId}`, { method: "DELETE" });
      if (res.status === 410) {
        setPhase("closed");
        return;
      }
      if (!res.ok) {
        await refresh();
        return;
      }
      setDrop((state) => ({ ...state, photos: state.photos.filter((p) => p.photoId !== photoId) }));
    } catch {
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (phase === "loading") return null;
  if (phase === "unavailable") return <p className={ui.alert}>Photos are not enabled.</p>;
  if (phase === "closed")
    return <p className={ui.alert}>This link has expired. Ask for a new one in chat.</p>;

  const count = drop.photos.length;

  return (
    <div className={`${ui.card} flex w-full flex-col gap-4`}>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={pending}
        aria-busy={pending}
        className={`flex aspect-square w-44 flex-col items-center justify-center gap-1 self-center rounded-card border border-dashed border-line text-muted transition-colors hover:border-accent hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none ${pending ? "animate-pulse" : ""}`}
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

      {drop.status === "attached" ? (
        <div className="flex flex-col items-center gap-3">
          <p className={`text-sm ${ui.muted}`}>On the review.</p>
          <a href={`/smokes/${drop.smokeId}`} className={ui.button}>
            Open the smoke
          </a>
        </div>
      ) : count > 0 ? (
        <p className={`text-sm ${ui.muted}`}>
          {count === 1
            ? "1 photo · attaches when the smoke is saved"
            : `${count} photos · attach when the smoke is saved`}
        </p>
      ) : null}

      {count > 0 ? (
        <ul className="flex flex-col gap-3">
          {drop.photos.map((photo) => (
            <li
              key={photo.photoId}
              aria-busy={busyId === photo.photoId}
              className={`flex items-start gap-3 transition-opacity ${busyId === photo.photoId ? "opacity-50" : ""}`}
            >
              <img
                src={`/api/photo-drops/${token}/photos/${photo.photoId}/thumb`}
                alt={photo.kind}
                className="aspect-square w-16 rounded-card object-cover"
              />
              <div className="flex min-w-0 flex-col items-start gap-2">
                <div className="flex flex-wrap gap-1">
                  {PHOTO_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={photo.kind === kind}
                      disabled={busyId === photo.photoId}
                      onClick={() => void patch(photo.photoId, { kind })}
                      className={`${filterChip.base} ${photo.kind === kind ? filterChip.active : filterChip.inactive}`}
                    >
                      {PHOTO_KIND_LABEL[kind]}
                    </button>
                  ))}
                </div>
                <Caption
                  photo={photo}
                  disabled={busyId === photo.photoId}
                  onCommit={(caption) => void patch(photo.photoId, { caption })}
                />
                <button
                  type="button"
                  aria-label="Remove photo"
                  disabled={busyId === photo.photoId}
                  onClick={() => void remove(photo.photoId)}
                  className={ui.button}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? (
        <p role="alert" className={ui.alert}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProductPhotoRights } from "@cj/domain";
import { api } from "@/lib/trpc/react";
import { ui } from "@/lib/ui";

// Admin-only product-photo affordances on the cigar detail page (DESIGN-003
// §Images). Quiet by design — one control row, no helper copy. State drives the
// pair shown: no row → Add photo + Upload link; suppressed → Approve + Replace;
// live (pending/approved) → Replace + Suppress. Upload posts to the same curator
// route the phone link consumes; Approve/Suppress ride the existing setPhotoRights
// mutation. On any change the server component refetches so the hero updates.
export function ProductPhotoAdmin({
  cigarId,
  initialRights,
}: {
  cigarId: string;
  initialRights: ProductPhotoRights | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const setRights = api.curation.setPhotoRights.useMutation({ onSuccess: () => router.refresh() });
  const mintLink = api.curation.mintPhotoUploadLink.useMutation({
    onSuccess: ({ token }) => {
      setLink(`${window.location.origin}/u/${token}`);
      setCopied(false);
    },
  });

  const busy = uploading || setRights.isPending || mintLink.isPending;

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("clientRequestId", crypto.randomUUID());
      const res = await fetch(`/api/product-photos/${cigarId}`, { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof body?.error === "string" ? body.error : "Upload failed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Upload failed.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const uploadLabel = initialRights === null ? "Add photo" : "Replace";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={ui.button}
          disabled={busy}
          aria-busy={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? "Uploading…" : uploadLabel}
        </button>

        {initialRights === null ? (
          <button
            type="button"
            className={ui.button}
            disabled={busy}
            onClick={() => mintLink.mutate({ cigarId })}
          >
            Upload link
          </button>
        ) : initialRights === "suppressed" ? (
          <button
            type="button"
            className={ui.button}
            disabled={busy}
            onClick={() =>
              setRights.mutate({ clientRequestId: crypto.randomUUID(), cigarId, rights: "approved" })
            }
          >
            Approve
          </button>
        ) : (
          <button
            type="button"
            className={ui.danger}
            disabled={busy}
            onClick={() =>
              setRights.mutate({ clientRequestId: crypto.randomUUID(), cigarId, rights: "suppressed" })
            }
          >
            Suppress
          </button>
        )}
      </div>

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

      {link ? (
        <div className="flex flex-wrap items-center gap-2">
          <input readOnly value={link} className={`${ui.field} min-w-0 flex-1 font-mono text-xs`} />
          <button
            type="button"
            className={ui.button}
            onClick={() => {
              void navigator.clipboard?.writeText(link);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}

      {error || setRights.error || mintLink.error ? (
        <p role="alert" className={`text-sm ${ui.muted}`}>
          {error ?? setRights.error?.message ?? mintLink.error?.message}
        </p>
      ) : null}
    </div>
  );
}

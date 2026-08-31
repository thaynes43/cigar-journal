import { addSmokePhoto, type SmokePhotoKind } from "@cj/domain";
import { processPhoto, UnsupportedImageTypeError } from "@cj/photos";
import { createContext } from "@/server/context";
import { photoStorage, MAX_UPLOAD_BYTES } from "@/lib/photos";
import { MAX_UPLOAD_LABEL } from "@/lib/upload-limits";
import { domainErrorResponse } from "@/lib/photo-http";

// Smoke-photo upload (ADR-007). Multipart in; the image is run through the shared
// pipeline (EXIF applied + stripped, normalized JPEG + thumb) before @cj/domain
// stores it under the caller's smoke. A separate route/envelope from save_smoke —
// a failed upload never touches the smoke.
export const dynamic = "force-dynamic";

const KINDS: readonly SmokePhotoKind[] = ["cigar", "band", "construction", "burn", "other"];

export async function POST(req: Request): Promise<Response> {
  const { deps, principal } = await createContext(req.headers);
  if (!principal) return Response.json({ error: "Not authenticated." }, { status: 401 });
  if (!photoStorage) return Response.json({ error: "Photos are not enabled." }, { status: 503 });

  const form = await req.formData();
  const file = form.get("file");
  const smokeId = form.get("smokeId");
  if (!(file instanceof File) || typeof smokeId !== "string" || smokeId.length === 0) {
    return Response.json({ error: "file and smokeId are required." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: `Image exceeds the ${MAX_UPLOAD_LABEL} limit.` }, { status: 413 });
  }

  const kindRaw = form.get("kind");
  const kind =
    typeof kindRaw === "string" && KINDS.includes(kindRaw as SmokePhotoKind)
      ? (kindRaw as SmokePhotoKind)
      : undefined;
  const captionRaw = form.get("caption");
  const caption =
    typeof captionRaw === "string" && captionRaw.trim().length > 0 ? captionRaw.trim() : undefined;

  const input = Buffer.from(await file.arrayBuffer());

  let processed;
  try {
    processed = await processPhoto(input, file.type);
  } catch (error) {
    if (error instanceof UnsupportedImageTypeError) {
      return Response.json({ error: error.message }, { status: 415 });
    }
    return Response.json({ error: "The image could not be processed." }, { status: 422 });
  }

  try {
    const view = await addSmokePhoto(deps, photoStorage, principal, {
      smokeId,
      kind,
      caption,
      image: {
        full: processed.full,
        thumb: processed.thumb,
        contentType: processed.contentType,
        width: processed.width,
        height: processed.height,
        bytes: processed.full.byteLength,
      },
    });
    return Response.json(view, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

import sharp from "sharp";
import heicConvert from "heic-convert";
import { UnsupportedImageTypeError } from "./errors.js";

// The one image pipeline both photo tiers share (ADR-007). Decode → apply EXIF
// orientation → strip all metadata → normalize to web JPEG → generate a thumb.
// Only pipeline output reaches the bucket; the original is never retained.

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp"]);
const HEIC = new Set(["image/heic", "image/heif"]);

const MAX_EDGE = 2048; // full image, longest side
const THUMB_MAX_EDGE = 480; // thumbnail, longest side
const FULL_QUALITY = 82;
const THUMB_QUALITY = 75;

export interface ProcessedPhoto {
  full: Buffer;
  thumb: Buffer;
  contentType: "image/jpeg";
  width: number;
  height: number;
}

// Normalize a declared content type ("image/JPEG; charset=..." → "image/jpeg").
function normalizeType(contentType: string): string {
  return contentType.toLowerCase().split(";")[0]?.trim() ?? "";
}

export async function processPhoto(input: Buffer, contentType: string): Promise<ProcessedPhoto> {
  const type = normalizeType(contentType);
  if (!ACCEPTED.has(type)) throw new UnsupportedImageTypeError(contentType);

  // HEIC/HEIF: convert to JPEG first via the WASM decoder (no native libheif),
  // then continue with sharp exactly like any other input.
  const source = HEIC.has(type)
    ? Buffer.from(await heicConvert({ buffer: input, format: "JPEG", quality: 1 }))
    : input;

  // .rotate() with no argument bakes in the EXIF orientation. Neither encode
  // calls withMetadata(), so the re-encode carries no EXIF/GPS forward.
  const { data: full, info } = await sharp(source)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: FULL_QUALITY })
    .toBuffer({ resolveWithObject: true });

  const thumb = await sharp(source)
    .rotate()
    .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();

  return { full, thumb, contentType: "image/jpeg", width: info.width, height: info.height };
}

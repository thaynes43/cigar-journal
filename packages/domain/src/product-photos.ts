import { eq } from "drizzle-orm";
import { productPhotos } from "@cj/db";
import type { Deps } from "./deps.js";
import { PhotoNotFoundError } from "./errors.js";

// The product tier of ADR-007: at most one photo per catalog cigar, captured by
// the crawler. Unlike smoke photos this read is NOT principal-scoped — a product
// photo belongs to the catalog, not a user; the serving route gates on any
// signed-in user. Storage keys stay server-side and are streamed through the
// authed proxy route, never referenced by key from a view.
export interface ProductPhotoObject {
  objectKey: string;
  thumbKey: string;
  contentType: string;
}

// Storage coordinates for one cigar's product photo, or PhotoNotFoundError when
// none exists (the route maps that to a 404).
export async function getProductPhoto(deps: Deps, args: { cigarId: string }): Promise<ProductPhotoObject> {
  const rows = await deps.db
    .select({
      objectKey: productPhotos.objectKey,
      thumbKey: productPhotos.thumbKey,
      contentType: productPhotos.contentType,
    })
    .from(productPhotos)
    .where(eq(productPhotos.cigarId, args.cigarId))
    .limit(1);
  const photo = rows[0];
  if (!photo) throw new PhotoNotFoundError();
  return photo;
}

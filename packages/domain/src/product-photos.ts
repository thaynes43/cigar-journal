import { and, eq, ne } from "drizzle-orm";
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
// none serves (the route maps that to a 404). A `suppressed` photo (rights
// takedown, DESIGN-003 §Curation) is treated as absent — never served, even to an
// authed principal — so the serving routes 404 naturally via this read. `pending`
// and `approved` both serve the authed catalog; the public gate (approved-only)
// lands with the public serving path.
export async function getProductPhoto(deps: Deps, args: { cigarId: string }): Promise<ProductPhotoObject> {
  const rows = await deps.db
    .select({
      objectKey: productPhotos.objectKey,
      thumbKey: productPhotos.thumbKey,
      contentType: productPhotos.contentType,
    })
    .from(productPhotos)
    .where(and(eq(productPhotos.cigarId, args.cigarId), ne(productPhotos.rights, "suppressed")))
    .limit(1);
  const photo = rows[0];
  if (!photo) throw new PhotoNotFoundError();
  return photo;
}

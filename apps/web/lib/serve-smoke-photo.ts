import "server-only";
import {
  getSmokePhoto,
  getPublicSmokePhoto,
  PhotoNotFoundError,
  type Deps,
  type Principal,
  type SmokePhotoObject,
} from "@cj/domain";

// Resolve the storage coordinates of a smoke photo for a viewer (issue #96).
// Photos are journal content: the owner sees their own; anyone may see a photo on
// a PUBLIC journal. The caller's own photo is tried first (so a private photo
// stays owner-visible); otherwise the visibility-gated public path decides. A
// photo that is neither owned nor public raises PhotoNotFoundError → one 404,
// leaking neither its existence nor its owner. `isPublic` selects the cache
// scope: shared bytes are publicly cacheable, owner bytes stay private.
export async function resolveViewablePhoto(
  deps: Deps,
  principal: Principal | null,
  photoId: string,
): Promise<{ photo: SmokePhotoObject; isPublic: boolean }> {
  if (principal) {
    try {
      return { photo: await getSmokePhoto(deps, principal, { photoId }), isPublic: false };
    } catch (error) {
      if (!(error instanceof PhotoNotFoundError)) throw error;
      // Not the caller's own photo — fall through to the public, visibility-gated path.
    }
  }
  return { photo: await getPublicSmokePhoto(deps, { photoId }), isPublic: true };
}

import "server-only";
import { photoStorageFromEnv, type PhotoStorage } from "@cj/photos";

// Photo storage wired once from the environment (ADR-007). Null when the bucket
// is unconfigured — the feature is then disabled and the web degrades
// gracefully: routes answer 503 and the upload UI is hidden.
export const photoStorage: PhotoStorage | null = photoStorageFromEnv();
export const photosEnabled = photoStorage !== null;

// The upload ceiling — the pipeline downsamples anything larger than we serve,
// so this only bounds what a route will decode (mirrors ADR-007 intake). It
// lives in a client-importable module because the /u/ page states the number to
// the user; re-exported here so the server routes keep one import.
export { MAX_UPLOAD_BYTES } from "./upload-limits";

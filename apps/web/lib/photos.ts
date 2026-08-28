import "server-only";
import { photoStorageFromEnv, type PhotoStorage } from "@cj/photos";

// Photo storage wired once from the environment (ADR-007). Null when the bucket
// is unconfigured — the feature is then disabled and the web degrades
// gracefully: routes answer 503 and the upload UI is hidden.
export const photoStorage: PhotoStorage | null = photoStorageFromEnv();
export const photosEnabled = photoStorage !== null;

// 15 MB upload ceiling — the pipeline downsamples anything larger than we serve,
// so this only bounds what the route will decode (mirrors ADR-007 intake).
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

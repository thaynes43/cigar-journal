// @cj/photos — the shared photo substrate (ADR-007): one private object store and
// one image pipeline, bound to a smoke or a catalog cigar by the DB row, not by
// storage layout. This package is storage + pipeline only; ownership and audit
// live in @cj/domain, which depends on the PhotoStorage type here alone.

export { processPhoto, type ProcessedPhoto } from "./pipeline.js";
export { UnsupportedImageTypeError } from "./errors.js";
export {
  createS3PhotoStorage,
  createMemoryPhotoStorage,
  photoStorageFromEnv,
  type PhotoStorage,
  type StoredObject,
  type S3PhotoStorageConfig,
} from "./storage.js";

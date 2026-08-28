// A source image whose declared content type the pipeline does not accept. Thrown
// by `processPhoto` before any decode so the web adapter can map it to a 415
// without leaking decoder internals. Kept minimal and typed so callers branch on
// the class, not a message.
export class UnsupportedImageTypeError extends Error {
  readonly contentType: string;
  constructor(contentType: string) {
    super(`Unsupported image type: ${contentType || "unknown"}.`);
    this.name = "UnsupportedImageTypeError";
    this.contentType = contentType;
  }
}

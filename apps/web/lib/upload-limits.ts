// The upload ceiling in one place, importable from the client. The API route
// enforces the number and the /u/ page states it to the user, and an error
// message that names the wrong limit is worse than no message at all — so the
// label is derived, never retyped.
//
// 20 MB matches @cj/mcp's MAX_ATTACHED_BYTES: both are a user's photo arriving
// at the same pipeline, and the upload link — the path that actually works —
// must not be the stricter of the two.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const MAX_UPLOAD_LABEL = `${MAX_UPLOAD_BYTES / (1024 * 1024)}MB`;

import { createAuthClient } from "better-auth/react";

// Browser client — talks to the same-origin /api/auth/* handler.
export const authClient = createAuthClient();

import { auth } from "@cj/auth";
import { toNextJsHandler } from "better-auth/next-js";

// Mounts every Better Auth endpoint under /api/auth/* (ADR-004). The handler is
// wrapped so `auth` (a lazy singleton) is only resolved per-request, never at
// build/module-eval time.
export const { GET, POST } = toNextJsHandler((request: Request) => auth.handler(request));

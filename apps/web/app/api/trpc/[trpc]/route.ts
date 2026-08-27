import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/context";

// The tRPC HTTP surface (ADR-001). Excluded from the middleware redirect so
// unauthenticated calls return a real UNAUTHORIZED rather than an HTML bounce.
function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req.headers),
  });
}

export { handler as GET, handler as POST };

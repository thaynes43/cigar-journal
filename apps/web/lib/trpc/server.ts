import "server-only";
import { headers } from "next/headers";
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/context";

// Server components read through an in-process caller — no HTTP hop, the same
// procedures (so the same authz) the HTTP surface runs.
export async function getServerCaller() {
  return appRouter.createCaller(await createContext(await headers()));
}

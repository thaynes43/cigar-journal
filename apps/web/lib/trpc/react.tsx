"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@/server/routers/_app";

// React Query bindings for the interactive surfaces (search-as-you-type, form
// mutations, inline delete). Server components read through the server caller
// instead, so this client never carries the router's server code — only its type.
export const api = createTRPCReact<AppRouter>();

function baseUrl(): string {
  if (typeof window !== "undefined") return "";
  return process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
}

export function TRPCProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    api.createClient({ links: [httpBatchLink({ url: `${baseUrl()}/api/trpc` })] }),
  );

  return (
    <api.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </api.Provider>
  );
}

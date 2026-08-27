import { router } from "../trpc";
import { smokesRouter } from "./smokes";
import { cigarsRouter } from "./cigars";

export const appRouter = router({
  smokes: smokesRouter,
  cigars: cigarsRouter,
});

export type AppRouter = typeof appRouter;

import { router } from "../trpc";
import { smokesRouter } from "./smokes";
import { cigarsRouter } from "./cigars";
import { inventoryRouter } from "./inventory";

export const appRouter = router({
  smokes: smokesRouter,
  cigars: cigarsRouter,
  inventory: inventoryRouter,
});

export type AppRouter = typeof appRouter;

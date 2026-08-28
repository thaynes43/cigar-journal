import { router } from "../trpc";
import { smokesRouter } from "./smokes";
import { cigarsRouter } from "./cigars";
import { catalogRouter } from "./catalog";
import { inventoryRouter } from "./inventory";

export const appRouter = router({
  smokes: smokesRouter,
  cigars: cigarsRouter,
  catalog: catalogRouter,
  inventory: inventoryRouter,
});

export type AppRouter = typeof appRouter;

import { router } from "../trpc";
import { smokesRouter } from "./smokes";
import { cigarsRouter } from "./cigars";
import { catalogRouter } from "./catalog";
import { inventoryRouter } from "./inventory";
import { curationRouter } from "./curation";

export const appRouter = router({
  smokes: smokesRouter,
  cigars: cigarsRouter,
  catalog: catalogRouter,
  inventory: inventoryRouter,
  curation: curationRouter,
});

export type AppRouter = typeof appRouter;

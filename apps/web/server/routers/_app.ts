import { router } from "../trpc";
import { smokesRouter } from "./smokes";
import { cigarsRouter } from "./cigars";
import { catalogRouter } from "./catalog";
import { inventoryRouter } from "./inventory";
import { curationRouter } from "./curation";
import { settingsRouter } from "./settings";

export const appRouter = router({
  smokes: smokesRouter,
  cigars: cigarsRouter,
  catalog: catalogRouter,
  inventory: inventoryRouter,
  curation: curationRouter,
  settings: settingsRouter,
});

export type AppRouter = typeof appRouter;

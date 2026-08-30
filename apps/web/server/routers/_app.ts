import { router } from "../trpc";
import { smokesRouter } from "./smokes";
import { cigarsRouter } from "./cigars";
import { catalogRouter } from "./catalog";
import { inventoryRouter } from "./inventory";
import { curationRouter } from "./curation";
import { settingsRouter } from "./settings";
import { invitesRouter } from "./invites";

export const appRouter = router({
  smokes: smokesRouter,
  cigars: cigarsRouter,
  catalog: catalogRouter,
  inventory: inventoryRouter,
  curation: curationRouter,
  settings: settingsRouter,
  invites: invitesRouter,
});

export type AppRouter = typeof appRouter;

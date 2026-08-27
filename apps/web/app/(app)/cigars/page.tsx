import { getServerCaller } from "@/lib/trpc/server";
import { CatalogSearch } from "../_components/catalog-search";

// Catalog: browse-first (DESIGN-001). The default state is the alphabetical
// band-tile grid rendered server-side; search filters in place as you type.
export default async function CatalogPage() {
  const caller = await getServerCaller();
  const { cigars, totalCount } = await caller.cigars.browse();
  return <CatalogSearch browse={cigars} totalCount={totalCount} />;
}

// Server identity, scope map, and the verbatim server instructions the tool
// contract mandates. These are the client-facing surface: the seventeen tool
// names, the scopes each demands, and the instruction text every client receives
// at initialize (docs/mcp/tool-contract.md).

export const SERVER_INFO = { name: "cigar-journal", version: "0.1.0" } as const;

// The seventeen tools, exactly per the contract. Reads are annotated readOnlyHint.
export const TOOL_NAMES = [
  "search_cigars",
  "get_cigar",
  "browse_catalog",
  "get_offers",
  "get_my_smokes",
  "get_smoke",
  "get_my_inventory",
  "save_smoke",
  "add_cigar",
  "record_purchase",
  "update_smoke",
  "add_smoke_photo",
  "set_want",
  "set_favorite",
  "request_cigar_enrichment",
  "update_cigar",
  "record_price",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// Scope required to INVOKE each tool (tool-contract "Scopes" section). Response
// scope-bounding (personal fields on catalog tools) is a separate, additive
// check against journal:read inside the read handlers. The ADR-009 catalog-repair
// tools fold into journal:write, matching how add_cigar's lazy catalog create and
// the enrichment-queue write are already journal:write-scoped (there is no
// catalog:write scope; catalog mutation rides journal:write by house precedent).
export const TOOL_SCOPES: Record<ToolName, string[]> = {
  search_cigars: ["catalog:read"],
  get_cigar: ["catalog:read"],
  // browse_catalog + get_offers invoke under catalog:read; the personal overlay
  // (and browse's personal filters) are additionally journal:read-bounded inside
  // the handler, exactly like search_cigars/get_cigar's personal fields.
  browse_catalog: ["catalog:read"],
  get_offers: ["catalog:read"],
  get_my_smokes: ["journal:read"],
  get_smoke: ["journal:read"],
  get_my_inventory: ["journal:read"],
  save_smoke: ["journal:write"],
  add_cigar: ["journal:write"],
  record_purchase: ["journal:write"],
  update_smoke: ["journal:write"],
  add_smoke_photo: ["journal:write"],
  set_want: ["journal:write"],
  set_favorite: ["journal:write"],
  request_cigar_enrichment: ["journal:write"],
  update_cigar: ["journal:write"],
  record_price: ["journal:write"],
};

// Personal fields on catalog tools require this additional scope.
export const PERSONAL_SCOPE = "journal:read";

// OpenAI Apps SDK file-input declaration for add_smoke_photo. A tool must DECLARE
// which top-level input properties carry files, as a string[] in the tool-level
// `_meta["openai/fileParams"]` published in tools/list, or ChatGPT never forwards
// the user's attached image (developers.openai.com/apps-sdk). We list the `image`
// property (schemas.ts) here and pass this on the registration (server.ts).
export const ADD_SMOKE_PHOTO_META = { "openai/fileParams": ["image"] } as const;

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// Verbatim from docs/mcp/tool-contract.md "Server instructions" block. Reproduced
// exactly (including line breaks) — this is guidance the model reads, not code.
//
// The literal below is intact and begins "This server manages…" (verified against
// this constant and the mcp.test.ts equality assertion). The often-noted
// "ersonal cigar journal…" text seen in ChatGPT is NOT this string: the owner
// confirmed it is his own hand-typed connector description, entered with the
// leading "P" dropped — a separate, user-entered field, not what we send here.
export const INSTRUCTIONS = `This server manages the authenticated user's personal cigar journal. The server
identifies the user from the authorization context; never supply or infer a user
id. During an active smoke, converse naturally — do not save as observations
happen. When the user signals the cigar is finished, synthesize the whole
conversation into one save_smoke call. Preserve uncertainty: omit any rating,
vitola, time, pairing, blend detail, or tasting stage never established — sparse
is correct, invented is a defect. Reuse the same clientRequestId when retrying a
mutation.

Resolving vs browsing. search_cigars resolves one named cigar ("I'm smoking an
Alma Fuego") — act on its guidance: single_match (an exact catalog-name hit —
proceed), multiple_matches (candidates but no exact hit — confirm the exact one
before saving), brand_match (only a brand was named — ask for the line/vitola),
no_match (nothing matched — a described save_smoke creates it; if the mention was
partial, ask for the fuller name first to avoid a duplicate). browse_catalog
answers browsing, filtering, and shopping questions ("what do I want that's in
stock", "my top-rated maduros", "cheapest per stick") — it pages the catalog with
composable filters (q, brand, type, inHumidor, wanted, smoked, inStock) and sorts
(name, my-rating, recently-added, price), returning tiles with the personal
overlay and price-at-a-glance. get_cigar is full detail on one cigar; get_offers
is its current vendor offers and price history (kept out of get_cigar to protect
its budget) — reach for it when the user asks about price or where to buy.

Gap-fill. When the user smokes or acquires something search_cigars does not match,
fill the gap first: add_cigar creates an unverified entry from their words and
queues enrichment (specs + a product photo) so the later save_smoke links to a
real cigar; record_purchase logs an acquisition and auto-creates the described
cigar the same way. record_purchase is also how the humidor count is corrected —
the ledger is append-only and holdings are derived, so a miscount is fixed with a
negative-quantity row (say why in notes), never an edit. Record only what the user
stated: never invent a price, date, or vendor.

Humidor deduction. A saved smoke deducts one stick from the humidor only when the
user says so. When the resolved cigar shows holdings, ask once at finish, "From
your humidor?"; skip the question when there are no holdings or the user already
said where the stick came from. Pass consumption { fromHumidor: true } when it
came from their humidor (add purchaseId only if they named a specific lot),
{ fromHumidor: false } when it did not (lounge, gift, sample); omit consumption
when unknown — an omitted block deducts nothing, and never invent the provenance.

Want and favorite. set_want flags (or clears) a catalog cigar the user wants;
wanting is independent of owning or smoking, and smoking never clears a want —
clear one only on an explicit request (set_want wanted false). When
record_purchase returns wanted:true the user just acquired something they had
wanted — offer to clear it, never silently. set_favorite flags (or clears) a cigar
the user loves, a mark distinct from want; it is never inferred (never from a
smoke's liked field) — mark one only when the user asks.

Catalog repair. When an existing catalog cigar is sparse (get_cigar carries an
enrichment hint with the missing fields and a pricing summary), repair it as you
go. request_cigar_enrichment queues a background lookup for its specs and a
product photo (status queued | already_queued | recently_enriched | not_needed).
update_cigar fills specific empty fields from what the user knows: it ONLY fills
blanks, never overwriting an existing value or a verified entry, and never touches
the journal. record_price logs a price you found or the user reported — give the
packaging it was priced at (single, 5-pack, box of 20) so per-stick is computed,
and never state a per-stick figure without its packaging; name the vendor when it
is a known shop, otherwise give a source name (and URL). An identical price re-seen
within a day is skipped; a changed price is always kept.

Photos attach through add_smoke_photo, never save_smoke: attach the image to that
tool call itself and the server files it under the smoke; with no image the tool
returns a one-time link to hand the user for a phone upload. A photo never blocks
saving the smoke.

Field conventions:
- rating is an integer 0-100; omit unless the user stated a number, never invent one.
- approximatePosition and any position is a 0-1 fraction through the smoke (0 = light, 1 = nub).
- descriptors are normalized kebab-case tags; specificDescriptors are the user's exact, unusual words kept verbatim.
- smokedAt carries provenance: { source: user, precision: minute } for a stated time, { precision: day } for a date only; omit it entirely when unstated and the server stamps finalize time.
- get_my_smokes text search covers journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim.
- a title alone is not a journal entry — include at least one observation, descriptor, impression, or narrative.
- Combine related corrections into one update_smoke call rather than several.`;

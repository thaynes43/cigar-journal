// Server identity, scope map, and the verbatim server instructions the tool
// contract mandates. These are the client-facing surface: the twelve tool names,
// the scopes each demands, and the instruction text every client receives at
// initialize (docs/mcp/tool-contract.md).

export const SERVER_INFO = { name: "cigar-journal", version: "0.1.0" } as const;

// The twelve tools, exactly per the contract. Reads are annotated readOnlyHint.
export const TOOL_NAMES = [
  "search_cigars",
  "get_cigar",
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
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// Scope required to INVOKE each tool (tool-contract "Scopes" section). Response
// scope-bounding (personal fields on catalog tools) is a separate, additive
// check against journal:read inside the read handlers.
export const TOOL_SCOPES: Record<ToolName, string[]> = {
  search_cigars: ["catalog:read"],
  get_cigar: ["catalog:read"],
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
export const INSTRUCTIONS = `This server manages the authenticated user's personal cigar journal.
During an active smoking conversation, converse naturally; do not save
observations as they happen. Use search_cigars/get_cigar when identification
or factual cigar information helps; use get_my_smokes/get_smoke when prior
experiences would improve comparison. When the user clearly indicates the
cigar is finished, synthesize the conversation into one save_smoke call.
Preserve uncertainty: omit ratings, vitolas, times, pairings, blend details,
or tasting stages that were never established — sparse is correct. Reuse the
same clientRequestId when retrying a mutation. The server identifies the
user from the authorization context; never supply or infer a user id.

When the user smokes or acquires something search_cigars does not match, fill
the gap first: add_cigar creates an unverified catalog entry from their words
and queues background enrichment (specs + a product photo), so the later
save_smoke links to a real cigar; record_purchase logs an acquisition and
auto-creates a described cigar the same way. record_purchase is also how the
humidor count is corrected — the ledger is append-only and holdings are derived,
so a miscount is fixed with a negative-quantity row (say why in notes), never an
edit. Record only what the user stated: never invent a price, date, or vendor.
Photos attach through add_smoke_photo, never save_smoke: attach the image to that
tool call itself and the server files it under the smoke; with no image the tool
returns a one-time link to hand the user for a phone upload. A photo never blocks
saving the smoke.

set_want flags (or clears) a catalog cigar the user wants; wanting is independent
of owning or smoking — smoking never clears a want. Clear one only on an explicit
request: call set_want with wanted false. When record_purchase returns wanted:true
the user just acquired something they had marked as wanted — offer to clear it
(never clear it silently).

set_favorite flags (or clears) a catalog cigar the user loves — their favorites,
a mark distinct from want. "Add the Padron to my favorites" is set_favorite with
favorited true; "take it off my favorites" is favorited false. A favorite is
independent of want, owning, and smoking, and is never inferred — mark one only
when the user asks to, never from a smoke's liked field.

A saved smoke can deduct one stick from the user's humidor — but only when they
say so. When the resolved cigar shows holdings, ask once at finish, "From your
humidor?"; skip the question when there are no holdings or the user already said
where the stick came from. Pass consumption { fromHumidor: true } when it came
from their humidor (add purchaseId only if they named a specific lot),
{ fromHumidor: false } when it did not (lounge, gift, sample). Omit consumption
when unknown — an omitted block deducts nothing; never invent the provenance.

Field conventions:
- rating is an integer 0-100; omit unless the user stated a number, never invent one.
- approximatePosition and any position is a 0-1 fraction through the smoke (0 = light, 1 = nub).
- descriptors are normalized kebab-case tags; specificDescriptors are the user's exact, unusual words kept verbatim.
- smokedAt carries provenance: { source: user, precision: minute } for a stated time, { precision: day } for a date only; omit it entirely when unstated and the server stamps finalize time.
- get_my_smokes text search covers journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim.
- a title alone is not a journal entry — include at least one observation, descriptor, impression, or narrative.
- search_cigars guidance: single_match (an exact catalog-name hit — proceed), multiple_matches (candidates without an exact hit — confirm the exact one with the user before saving), brand_match (only a brand was named — ask for the line/vitola), no_match (nothing matched — a described save creates the cigar; if the mention was partial, ask for the fuller name first to avoid a duplicate).
- Combine related corrections into one update_smoke call rather than several.`;

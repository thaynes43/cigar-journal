// Server identity, scope map, and the verbatim server instructions the tool
// contract mandates. These are the client-facing surface: the tool names, the
// scopes each demands, and the instruction text every client receives at
// initialize (docs/mcp/tool-contract.md).

export const SERVER_INFO = { name: "cigar-journal", version: "0.1.0" } as const;

// The tool surface. The first seventeen are the conversational journal contract
// (reads annotated readOnlyHint). The final thirteen are the admin catalog-curation
// surface (DESIGN-003 wave 4a/4b, issue #126; the taxonomy four from ADR-012 Wave 3,
// issue #196): the ops-agent tools, gated on `curation:*` scope AND an admin-role
// principal — additive, existing tools and scopes untouched (R-MCP-4).
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
  // Curation surface (admin-only) — one paged read + twelve curator writes.
  "get_curation_queue",
  "set_listing_match_status",
  "set_cigar_facts",
  "verify_cigar",
  "exclude_cigar",
  "restore_cigar",
  "set_product_photo_rights",
  "rename_cigar",
  "queue_enrichment_backlog",
  // The taxonomy verbs (ADR-012 Wave 3, issue #196): find-or-mint a registry
  // path, edit the spellings a registry row answers to, place a leaf in the
  // structure, and split an entry that stands for several products.
  "register_taxonomy",
  "update_registry_aliases",
  "assign_cigar_taxonomy",
  "split_cigar",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// Scope(s) that AUTHORIZE each tool (tool-contract "Scopes" section) — holding ANY
// one listed scope suffices (assertToolScope, the in-handler backstop, enforces the
// any-of rule). Every tool lists exactly ONE scope EXCEPT get_cigar, so for all the
// others "any-of" collapses to "require that scope"; get_cigar accepts catalog:read
// OR curation:read (the curate agent reads a cigar's full detail while triaging,
// under a curation-only token — #126). Response scope-bounding (personal fields on
// catalog tools) is a separate, additive check against journal:read inside the read
// handlers. The ADR-009 catalog-repair tools fold into journal:write, matching how
// add_cigar's lazy catalog create and the enrichment-queue write are already
// journal:write-scoped (there is no catalog:write scope; catalog mutation rides
// journal:write by house precedent).
export const TOOL_SCOPES: Record<ToolName, string[]> = {
  search_cigars: ["catalog:read"],
  // catalog:read OR curation:read — the one any-of tool (see the block comment).
  get_cigar: ["catalog:read", "curation:read"],
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
  // Curation surface (DESIGN-003 wave 4a, extended by ADR-012 Wave 3). The read
  // takes curation:read, the twelve writes curation:write — a separate scope pair from journal/catalog, so a
  // journal:write token can never reach a curation tool. Scope is necessary but
  // NOT sufficient: every curation handler also requires an admin principal (the
  // domain services assert the curator role, and the adapter re-checks), so a
  // curation-scoped token on a non-admin user is rejected exactly like the web
  // adminProcedure rejects.
  get_curation_queue: ["curation:read"],
  set_listing_match_status: ["curation:write"],
  set_cigar_facts: ["curation:write"],
  verify_cigar: ["curation:write"],
  exclude_cigar: ["curation:write"],
  restore_cigar: ["curation:write"],
  set_product_photo_rights: ["curation:write"],
  rename_cigar: ["curation:write"],
  // #154 rides curation:write, NOT journal:write like the ADR-009 repair tools:
  // it is curator-gated, worklist-scoped and run-attributed, so it is the curation
  // surface by every existing criterion. The consequence is the point — the curate
  // agent's live token already holds curation:write, so no token's reach widens.
  // Granting that agent journal:write instead (to loop request_cigar_enrichment)
  // would hand a catalog agent the owner's journal — save_smoke, record_purchase,
  // set_want — for one enqueue action.
  queue_enrichment_backlog: ["curation:write"],
  register_taxonomy: ["curation:write"],
  update_registry_aliases: ["curation:write"],
  assign_cigar_taxonomy: ["curation:write"],
  split_cigar: ["curation:write"],
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
mutation — one id per mutation, not one per turn, so a second call in the same
turn takes its own.

Resolving vs browsing. search_cigars resolves one named cigar ("I'm smoking an
Alma Fuego") — act on its guidance: single_match (an exact catalog-name hit —
proceed), multiple_matches (candidates but no exact hit — confirm the exact one
before saving), brand_match (only a brand was named — ask for the line/vitola),
no_match (nothing matched — fill the gap below, then save; if the mention was
partial, ask for the fuller name first to avoid a duplicate). browse_catalog
answers browsing, filtering, and shopping questions ("what do I want that's in
stock", "my top-rated maduros", "cheapest per stick") — it pages the catalog with
composable filters (q, brand, type, inHumidor, wanted, smoked, inStock) and sorts
(name, my-rating, recently-added, price), returning tiles with the personal
overlay and price-at-a-glance. get_cigar is full detail on one cigar; get_offers
is its current vendor offers and price history (kept out of get_cigar to protect
its budget) — reach for it when the user asks about price or where to buy.

Gap-fill. When you are about to log a smoke or a purchase and search_cigars
matched nothing, fill the gap first: add_cigar creates an unverified entry from
their words and queues enrichment (specs + a product photo) so the save_smoke
that follows links to a real cigar; record_purchase logs an acquisition and
auto-creates the described cigar the same way. Gap-fill is a prelude, never the
answer. add_cigar writes NO journal entry — its result says so,
journalEntryCreated:false — so the request is not complete until the save_smoke
or record_purchase that motivated it has run in the same turn, against the
cigarId add_cigar returned. A catalog row with no journal entry is worse than
no row at all: it looks like success and drops what the user actually said. If
add_cigar or record_purchase errors cigar_ambiguous, show the search_cigars
candidates and ask; only when the user confirms none is theirs, re-issue the
same call with confirmedDistinct:true to create the distinct product — for a
purchase that is one call, not a detour through add_cigar. save_smoke can
error it too and has no such flag: show the candidates, then either save
against the cigarId the user confirms — its clientRequestId is unspent, the
ambiguity wrote nothing — or create the product with add_cigar
confirmedDistinct:true and save against the cigarId it returns under a FRESH
clientRequestId, since add_cigar spent the first one. A spent id is
idempotency_conflict, which does not recover. record_purchase is
also how the humidor count is corrected — the ledger is append-only and
holdings are derived, so a miscount is fixed with a negative-quantity row (say
why in notes), never an edit. Record only what the user stated: never invent a price, date, or
vendor.

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

Photos attach through add_smoke_photo, never save_smoke. Call it with just the
smoke id: you get back a one-time upload link — relay it to the user, it works
once and lasts 24 hours, and shareWithUser is the sentence to say. If the host
forwarded an attached image with the call the photo is stored directly instead and
no link is needed; delivery.status reports which happened. A host that forwards
anything is understood to forward only an image attached to the message that
triggered the call, so when the user wants one stored directly ask them to
attach (or re-attach) it in the same message as the request; the link works
either way. Never fill the image argument yourself, and never paste an image, a
chat file link, or a file id into any field. A photo never blocks saving the
smoke.

Field conventions:
- rating is an integer 0-100; omit unless the user stated a number, never invent one.
- approximatePosition and any position is a 0-1 fraction through the smoke (0 = light, 1 = nub).
- descriptors are normalized kebab-case tags; specificDescriptors are the user's exact, unusual words kept verbatim.
- smokedAt carries provenance: { source: user, precision: minute } for a stated time, { precision: day } for a date only; omit it entirely when unstated and the server stamps finalize time.
- get_my_smokes text search covers journal title and narrative, impression, construction notes, imported original markdown, and progression verbatim.
- a title alone is not a journal entry — include at least one observation, descriptor, impression, or narrative.
- Combine related corrections into one update_smoke call rather than several.

Catalog curation (admin only). The get_curation_queue read and the twelve curation
write tools are for an operations agent maintaining the catalog — not for
conversational journaling; a normal chat session never uses them. get_curation_queue
pages the work by kind (unverified, duplicates, match_triage, unbranded, unlined,
unblended, untyped, missing_photos); drain a kind with its nextCursor. A
match_triage row carries a status: auto is a proposed link to rule on, unmatched is
a listing the crawler linked to nothing and its reason says why: no_anchor means
the title spelled the marca a way the registry does not know, and ambiguous means a
brand anchored but no single entry under it settled. Apply only what the evidence
supports: high-confidence corrections apply directly (set_cigar_facts overwrites a
wrong brand/line/type/manufacturer; rename_cigar corrects a wrong canonical name;
verify_cigar; set_listing_match_status confirmed/unmatched; exclude_cigar for
non-cigar pollution, restore_cigar to undo; set_product_photo_rights
approved/suppressed); low-confidence cases are skipped and
reported, never guessed — leave an uncertain brand or type null rather than invent
one. Every unmatch states its reason: pass unmatchedReason (no_match, no_anchor,
ambiguous, market_refusal) whenever you call set_listing_match_status unmatched. A
stated reason is a verdict later enrichment preserves; an unmatch with none is read
as a report on the catalog at that moment, which a later enrichment ask may
supersede by linking the listing anyway.
exclude_cigar never applies to a cigar anybody holds: a worklist row whose
heldLots is above zero has purchase lots pointing at it, and the server refuses the
exclude outright — enforced, not advised, and there is no override. Skip such a row
or rename it; a sampler someone bought is a catalog entry, not pollution.
queue_enrichment_backlog is the operator's bulk enqueue of the photoless
holdings, NOT part of a curation run: do not call it on your own initiative — report
the worklist and leave the press to the operator. It queues a cigar only once its
canonical name is verified and a crawl-enabled vendor covering that market has
completed an enrich run; every other row comes back with the reason and nothing is
written for it. Enrichment matches on the canonical name, so the way to make a row
enqueueable is rename_cigar then verify_cigar. Pass runId (the batch id) and
confidence (0-1) on every write so the run is auditable and reversible. Merges stay
human-only in the web console — there is no merge tool here.

Catalog structure (admin only). A cigar hangs off a brand, a line under that, a
blend under that, with a vitola on the leaf itself. The three structural queue
kinds are one ladder worked in order — unbranded, then unlined, then unblended —
and a row leaving one appears in the next. For a row: decide the levels from the
evidence, call register_taxonomy to find or mint the brand, line and blend it needs
(finding and minting are the same call, and created says which happened), then
assign_cigar_taxonomy with the ids it returned. Never invent a level. Unknown stays
out, and a cigar whose line nobody knows correctly hangs off its brand alone —
that is a finished row, not a gap. Setting nameSource composed hands the canonical
name over to the parts; send preview true first to see the name they compose to
before the flip. update_registry_aliases is what closes a no_anchor listing: add
the spelling as a key on the entity it names, never loosen the match. A key some
other entity already claims is refused and that entity is named — use it rather
than working around it, because the refusal is usually a near-duplicate caught.
split_cigar breaks an entry that has been standing for several products into the
leaves it should have been and moves each product's listings onto its own; split
only on unambiguous listing evidence, leave the rest, and expect a partial split.
It refuses a listing a curator or agent already ruled on. A leaf it mints inherits
the line and blend you leave out from the entry being split, and minting is
get-or-create like register_taxonomy — parts that already name a live entry
re-point onto it rather than growing a second copy of it.`;

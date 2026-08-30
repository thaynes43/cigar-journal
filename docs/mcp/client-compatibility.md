# LLM Client Compatibility

Per-client capability notes for the Cigar Journal MCP server. **This
document goes stale by design** — client products evolve independently of
this application. Re-verify before relying on any row.

```yaml
lastVerified: 2026-08-26        # Phase 0 spike, OAuth mode, at
                                # https://cigars.haynesnetwork.com — all
                                # three target clients tested live
```

> The Cigar Journal supports journal reads and writes. Whether a particular
> LLM client exposes those operations to its user is a property of that
> client, not a limitation of the Cigar Journal domain.

## Matrix

Values: `verified` (proven against the Phase 0 spike, date noted) ·
`documented` (official docs only) · `unverified` · `unsupported`.

| Capability | ChatGPT Web¹ | Claude Code | Codex CLI | Generic MCP client |
|---|---|---|---|---|
| Remote MCP (Streamable HTTP) | **verified** 08-26 | **verified** 08-26 | **verified** 08-26 | protocol-dependent |
| OAuth 2.1 + PKCE + discovery | **verified** 08-26 (owner authenticated via the connector flow) | **verified** 08-26 (DCR, S256, state, RFC 8707 resource, `offline_access`; accepts pasted redirect URL — headless-drivable) | **verified** 08-26 (native `codex mcp login`; localhost callback — headless-drivable) | protocol-dependent |
| Read tools | **verified** 08-26 | **verified** 08-26 (authless and authenticated) | **verified** 08-26 | yes if connected |
| Write tools | **verified** 08-26 | **verified** 08-26; server-derived identity confirmed | **verified** 08-26; server-derived identity confirmed | yes if connected |
| Write confirmation UX | **none observed** — the write executed with no prompt, despite OpenAI docs saying writes confirm by default. Keep `readOnlyHint` annotations anyway; treat confirmation as host-owned and changeable | **verified**: governed by Claude Code's permission system (interactive prompt / `--allowedTools`), not MCP annotations | **verified**: governed by codex approval/sandbox policy — headless `exec` auto-cancelled the write until `sandbox_mode=danger-full-access` + `approval_policy=never` | client-dependent |
| Tool availability late in a long conversation | unverified — initial test needed no per-turn selection, but a 90-minute smoke hasn't been simulated; observe during first real sessions | **verified**: tools persist for the session | **verified**: tools persist for the session | client-dependent |
| Token refresh / long-lived link | unverified — first test was same-session; observe across days of real use | **verified** 08-26: silent refresh after 10-min token expiry, rotation honored (server `refresh_rotated`) | unverified (session outlived no token in test) | client-dependent |
| Reconnect after expiry | unverified | **verified** 08-26: post-expiry call succeeds, no user interaction | unverified | client-dependent |

¹ Owner's account, Developer Mode, 2026-08-26 (spike). **Production
verified 2026-08-27**: ChatGPT Web connected to the real server end to end
— DCR, PKCE authorize, session-gated consent, token exchange (1h tokens +
refresh grant), live search_cigars/get_my_smokes calls. Two client-cache
traps burned in: connectors cache AS metadata (root-path aliases now
served) and consent buttons must bind the decision (Next drops submit
name/value under formAction). Cross-client persistence verified on the
spike: a ChatGPT write read back by both CLIs.

Environment note: clients running inside the cluster need IPv4-first DNS
(`NODE_OPTIONS=--dns-result-order=ipv4first` for Node-based CLIs) — the
cluster has no IPv6 egress and cigars.haynesnetwork.com publishes AAAA
records. Irrelevant for cloud-side clients like ChatGPT Web.

## Known platform behaviors (ChatGPT Web)

**Call latency is ChatGPT-platform-side, not ours (2026-08-27).** Second
field test: end-to-end tool calls stay ~5–7 s each, *unchanged* after the
server switched to MCP JSON response mode (`MCP_JSON_RESPONSE=true`).
Server-side handling is ~4 ms (per-tool `latencyMs` in the structured logs),
so the ~5–7 s is overhead inside the ChatGPT platform (model round-trip +
connector transport), not the Cigar Journal server. No server-side lever
meaningfully moves it — treat it as a platform property, not a regression to
chase.

**Connector manifest staleness (2026-08-27).** ChatGPT exposes no model-side
refresh of a connector's tool manifest: new tool schemas and descriptions
(e.g. the `matchedIn`/`matchSnippet` fields and the title-is-metadata
instruction line; the eleventh tool `set_want`, the `record_purchase.wanted`
result field, and the `get_cigar` `wanted` overlay added with Want v1; the
twelfth tool `set_favorite`, its instruction paragraph, and the `get_cigar`
`favorited` overlay added with Favorites v1; the ADR-008 `consumption` block +
ask-once "From your humidor?" instruction added with explicit consumption; the
thirteenth–fifteenth tools `request_cigar_enrichment` / `update_cigar` /
`record_price`, their catalog-repair instruction paragraph, and the additive
`get_cigar` `enrichment` + `pricing` blocks added with price observations +
catalog repair, ADR-009; the sixteenth–seventeenth tools `browse_catalog` /
`get_offers`, browse_catalog's personal-overlay + price-at-a-glance tiles, and the
consolidated server instructions added with the unified-catalog MCP surface,
PRD-003 R-MCP-1/-2) reach
a client **only after the user refreshes the connector in ChatGPT settings, then
starts a new chat** (schema cache is per-conversation — see below). The often-noted
"`ersonal cigar journal…`" text is neither a truncation bug nor our string:
the owner confirmed it is his own hand-typed connector description in ChatGPT,
entered with the leading "P" dropped. Our `INSTRUCTIONS` string — a separate,
server-owned field — is verified intact (server constant + `mcp.test.ts`
equality assertion), so nothing in what we send is affected. Re-check the
rendered instructions and tool descriptions after a user-initiated connector
refresh.

## ChatGPT manifest caching (verified 2026-08-27/28)

Tool *descriptions* and input *schemas* are cached separately, and schema
cache is **per-conversation**: after the user refreshes the connector in
settings, an existing conversation keeps serving stale input schemas while
a brand-new chat sees the current manifest (verified live: fresh session
reported the rating bounds, position semantics, and title rule; the same
checks were stale in the pre-refresh conversation). Practical rule: after
any tool-schema deploy, refresh the connector once, then start a new chat.
Deleting/re-adding the connector is not required.

**2026-08-29 — additive `add_cigar` schema change.** `add_cigar` gained an
optional boolean `confirmedDistinct` (default false = unchanged behavior): the
recovery for a near-match deadlock (the strong-link guard now also refuses
one-sided-number and packaging variants like "Davidoff Signature 2000" vs
"…Signature" / "…Signature 2000 Tubos Pack"). The model sets it only after
search_cigars candidates were shown and the user confirmed none is theirs; a
case-insensitive exact-name match still links. Additive and backward-compatible,
but per the per-conversation schema cache above it reaches ChatGPT only after a
**connector refresh AND a new chat** — an in-flight conversation keeps serving
the pre-change schema and cannot pass the new field.

## 2026-08-29 — additive curation tool surface (admin only, DESIGN-003 wave 4a)

The MCP server gained an **admin-only catalog-curation surface** (issue #126) —
the primitives the `curate` ops agent drives over HTTP. Two new OAuth scopes,
`curation:read` and `curation:write`, join the AS's `scopes_supported`; seven new
tools join the manifest: `get_curation_queue` (paged read — kinds `unverified`,
`duplicates`, `match_triage`, `unbranded`, `untyped`, `missing_photos`),
`set_listing_match_status`, `set_cigar_facts`, `verify_cigar`, `exclude_cigar`,
`restore_cigar`, `set_product_photo_rights`. There is deliberately **no merge
tool** — merges stay human-only in the web console.

**Existing clients are unaffected.** This is purely additive (R-MCP-4): the
seventeen journal/catalog tools, their scopes, and their schemas are unchanged. A
normal connector token carries `catalog:read`/`journal:*` and never the
`curation:*` scopes, so the curation tools are invisible-in-practice and
unreachable to it — a curation `tools/call` on a token lacking the scope returns
`403 insufficient_scope`. The scope alone is not enough: every curation tool also
requires an **admin-role principal** (the role is server-derived from the token via
`users.role`), so a `curation:*` token minted for a non-admin user is rejected with
`unauthorized`, exactly as the web `adminProcedure` rejects. Curation writes stamp
`audit_log.actor = 'agent'` and thread the run's `run_id` + `confidence`, distinct
from conversational writes (`mcp`). No client re-verification is needed for the
journal workflow; per the per-conversation manifest cache above, the new tools
reach a client only after a connector refresh and a new chat — but they are not
intended for conversational clients at all.

## 2026-08-30 — in-chat image attachment: what is verified, what is not

**Verified on the wire (live `tools/list`, authenticated, production endpoint).**
`add_smoke_photo` publishes `_meta = {"openai/fileParams": ["image"]}` and an
object-typed top-level `image` property, out of `required`. The manifest/declaration
hypothesis for the owner's failure is **disproven** — the declaration is correct and
ChatGPT is reading it.

**Verified in Loki.** The owner's failing call is recorded:
`[mcp] tool_called {"tool":"add_smoke_photo","latencyMs":9}` — and that was the
*entire* record. The model behaved correctly: it called with `{ smokeId, kind }` and
did **not** invent an `image` field, exactly as the tool contract asks. The smoke
saved fine; only the photo fell back to the mode-B link. Nothing in the log could
say whether an image argument arrived, whether request `_meta` arrived, or why mode
B was chosen — and a `file_id`-only handle would have looked identical to no image
at all.

**Still unresolved: does ChatGPT forward an in-chat image to the tool call?** The
user had uploaded photos *earlier in the same conversation*, not in the invoking
turn. The leading hypothesis is that only a file attached to the *current* turn is
forwarded — but that is a hypothesis drawn from one transcript, not a verified fact.

**It is a hypothesis here and nowhere else.** No model-facing string asserts it: not
the tool description, not the server `INSTRUCTIONS`, not the contract. An earlier
draft did — it told the model, on `no_image_received`, to ask the user to re-send the
photo with their next message — which states an unverified guess as fact and, if the
guess is wrong, costs the user a pointless round trip before they are offered the
link that actually works. So **the link leads** in every branch, and
`delivery.status` is used to say something true about why, not to withhold it.

The `photo_intake_request` record (tool-contract.md, "Intake diagnostics") is what
will settle the hypothesis: it is written before input validation, on the raw
JSON-RPC body, and it describes `params` itself as well as `arguments` and
`params._meta` — so it reports the keys the host actually sent, including keys the
server does not read. If the owner's next live test attaches a photo in the invoking
turn and the record still shows nothing delivered, the hypothesis is wrong; if a key
we never read turns up, that is the answer.

**What shipped meanwhile.** Named intake outcomes in the log; a schema that no
longer rejects an odd `image` before it can be recorded; acceptance of alternate URL
keys and magic-byte type sniffing; an SSRF guard that decides on the parsed address
rather than the spelling of the host; fetch/decode failure falling back to the mode-B
link instead of erroring; and
a `delivery.status` on the mode-B result so the model can tell the user something
true. **This may not make in-chat attachment work at all.** If ChatGPT forwards
nothing, the outcome is a precise diagnosis and honest model guidance — mode B stays
the working path, and the logs become the evidence for an upstream report.

**Re-testing requires a connector refresh AND a new chat.** The tool description and
server instructions changed, and per the manifest-cache section above an in-flight
conversation keeps serving the pre-change text. Testing without both is testing the
old description against the new server, and the result is uninterpretable.

## Workflows

**Ideal (design target):** the user talks to ChatGPT normally for the whole
smoke; on "that's it," the model calls `save_smoke`. Phase 0 shows this is
live-reachable today on the owner's account — reads *and* writes worked from
normal Chat with no confirmation friction. Remaining watch item: connector
availability across a very long conversation.

**Fallback (if a client loses write tools):** the model produces the exact
`save_smoke` payload as text; the user pastes it into the site's import page
or hands it to a write-capable client (Claude Code / Codex) to invoke
verbatim. Same schema, same validation (tool contract, fallback section).

**Alternate full clients:** Claude Code and Codex both proved the complete
read + write workflow against the identical server. The product's UX model
remains a normal conversational assistant; MCP schemas stay optimized for
conversational tool use, not coding-agent automation.

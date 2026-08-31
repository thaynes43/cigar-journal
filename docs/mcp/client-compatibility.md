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
hypothesis for the owner's failure is **disproven as a spelling problem** — what we
publish is correct and well-formed. It does **not** follow that the host acts on it;
that reading was assumed here and the 2026-08-31 capture below contradicts it. All
that is established is: we declare it properly, and the declaration reaches the
client.

**Verified in Loki.** The owner's failing call is recorded:
`[mcp] tool_called {"tool":"add_smoke_photo","latencyMs":9}` — and that was the
*entire* record. The model behaved correctly: it called with `{ smokeId, kind }` and
did **not** invent an `image` field, exactly as the tool contract asks. The smoke
saved fine; only the photo fell back to the mode-B link. Nothing in the log could
say whether an image argument arrived, whether request `_meta` arrived, or why mode
B was chosen — and a `file_id`-only handle would have looked identical to no image
at all.

**Then unresolved: does ChatGPT forward an in-chat image to the tool call?**
(Answered on 2026-08-31 — no. See the next section; the reasoning is kept because
it is why the probe was built.) The user had uploaded photos *earlier in the same
conversation*, not in the invoking turn. The leading hypothesis was that only a file
attached to the *current* turn is forwarded — a hypothesis drawn from one
transcript, not a verified fact.

**It is a hypothesis here and nowhere else.** No model-facing string asserts it: not
the tool description, not the server `INSTRUCTIONS`, not the contract. An earlier
draft did — it told the model, on `no_image_received`, to ask the user to re-send the
photo with their next message — which states an unverified guess as fact and, if the
guess is wrong, costs the user a pointless round trip before they are offered the
link that actually works. So **the link leads** in every branch, and
`delivery.status` is used to say something true about why, not to withhold it.

The `photo_intake_request` record (tool-contract.md, "Intake diagnostics") is what
settled it: written before input validation, on the raw JSON-RPC body, describing
`params` itself as well as `arguments` and `params._meta` — so it reports the keys
the host actually sent, including keys the server does not read. The next section is
what it found.

**What shipped meanwhile.** Named intake outcomes in the log; a schema that no
longer rejects an odd `image` before it can be recorded; acceptance of alternate URL
keys and magic-byte type sniffing; an SSRF guard that decides on the parsed address
rather than the spelling of the host; fetch/decode failure falling back to the mode-B
link instead of erroring; and a `delivery.status` on the mode-B result so the model
can tell the user something true. It was written down at the time that this might
not make in-chat attachment work at all — it did not, and the payoff was the one
predicted: a precise diagnosis, honest model guidance, and logs that are now the
evidence for an upstream report.

## 2026-08-31 — settled: ChatGPT forwards nothing

`photo_intake_request` did its job. A live authenticated `tools/call` from ChatGPT
at 03:00:40Z, captured in Loki, carried **no file params on any channel**:

```
metaFileParams: {"type":"absent"}     # no _meta["openai/fileParams"]
argImage:        absent                # the declared `image` argument unfilled
                                       # and no undeclared keys on params or arguments
```

The record is written before input validation on the raw JSON-RPC body and
enumerates the keys the host actually sent — including keys the server does not
read — so "absent" here means absent, not unparsed. `mode: attached` has never been
observed in production, on any client.

**What that settles.** The turn-recency hypothesis above is moot: the question was
never *which* image ChatGPT forwards to this connector, it is that it forwards
none. The upload link is not the fallback — it is the flow, which is why the tool
description, the server instructions and the contract now lead with it.

**It is not that the mechanism does not exist.** ChatGPT *can* hydrate
`openai/fileParams`: third-party operators report their servers receiving
`{ file_id, download_url }` objects through it. So the feature is real and our
declaration is well-formed — it has simply never been aimed at this connector.

**The leading explanation is host-side gating, not our schema.** Codex's source
restricts `fileParams` to its own first-party apps server, under an explicit
"Disallow custom MCPs from uploading files via fileParams". Developer-mode ChatGPT
connectors plausibly sit behind the same policy. If so, nothing we ship changes the
outcome, and no amount of schema polish will.

**One falsifiable lead before accepting that — now run.** Integrations that
reportedly do receive files declare a **strict four-property file schema** for the
param (`download_url`, `file_id`, `mime_type`, `file_name`); we published the object
via a preprocess/passthrough wrapper, which emitted a looser shape. **Experiment 1
(2026-08-31, issue #202)** aligned it: `image` is now that exact shape, all four
optional strings, `additionalProperties: false`, wrapper and marker gone
([tool-contract.md](tool-contract.md), "File intake"). This separates "our
declaration is subtly off" from "custom connectors are gated out" and nothing else —
it is one experiment, not a redesign, and it reverts if intake does not move.

**The retest.** The owner attaches an image in ChatGPT and calls `add_smoke_photo`
after a connector refresh and in a new chat (see below). `photo_intake_request`
answers: a hydrated `image` or `openai/fileParams` entry means the shape was the
cause; another `metaFileParams: {"type":"absent"}` with no `image` argument means it
was not, and gating is the remaining explanation.

**No other host has the mechanism at all.** Claude cannot extract attachment bytes
into tool arguments — architecturally out of reach, per Anthropic's own tracker —
and Cursor and VS Code are the same. The MCP spec itself has no file-input
primitive; the SEP drafts (2356 / 1306) our handle names track are unratified. So
even if ChatGPT started forwarding tomorrow, the upload link would remain the only
path that works everywhere. That is the durable reason it leads, independent of
how the OpenAI question resolves.

**What it does not settle.** Whether the gating is deliberate, temporary, or a
bug. The Loki signature `photo_intake_request` is the evidence base for an upstream
report to OpenAI; keep the probe and its logging in place. Mode A stays implemented
— it costs a branch and it is how this works the day forwarding lands.

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

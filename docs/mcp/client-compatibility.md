# LLM Client Compatibility

Per-client capability notes for the Cigar Journal MCP server. **This
document goes stale by design** — client products evolve independently of
this application. Re-verify before relying on any row.

```yaml
lastReviewed: 2026-09-09        # photo path sentence (2026-09-09 section); go-live sweep was #97, 08-31
clientMatrixVerified: 2026-08-26 # Phase 0 spike, OAuth mode — all three target
                                # clients driven live against
                                # https://cigars.haynesnetwork.com. The per-cell
                                # dates in the matrix are what actually matters;
                                # no client has been re-driven end to end since,
                                # so this date has NOT moved.
productionEvidence: 2026-08-31  # live authenticated ChatGPT tool calls captured
                                # in Loki (see the dated sections below), and a
                                # service-token `tools/list` against production
```

> The Cigar Journal supports journal reads and writes. Whether a particular
> LLM client exposes those operations to its user is a property of that
> client, not a limitation of the Cigar Journal domain.

## Matrix

Values: `verified` (driven live, date noted — originally against the Phase 0
spike, since then against production and the Loki record) · `documented`
(official docs only) · `unverified` · `unsupported`.

| Capability | ChatGPT Web¹ | Claude Code | Codex CLI | Generic MCP client |
|---|---|---|---|---|
| Remote MCP (Streamable HTTP) | **verified** 08-26 | **verified** 08-26 | **verified** 08-26 | **verified** 08-31 — a service token drove `initialize` + `tools/list` against production |
| OAuth 2.1 + PKCE + discovery | **verified** 08-26 (owner authenticated via the connector flow) | **verified** 08-26 (DCR, S256, state, RFC 8707 resource, `offline_access`; accepts pasted redirect URL — headless-drivable) | **verified** 08-26 (native `codex mcp login`; localhost callback — headless-drivable) | protocol-dependent |
| Read tools | **verified** 08-26 | **verified** 08-26 (authless and authenticated) | **verified** 08-26 | yes if connected |
| Write tools | **verified** 08-26 | **verified** 08-26; server-derived identity confirmed | **verified** 08-26; server-derived identity confirmed | yes if connected |
| Write confirmation UX | **none observed** — the write executed with no prompt, despite OpenAI docs saying writes confirm by default. Keep `readOnlyHint` annotations anyway; treat confirmation as host-owned and changeable | **verified**: governed by Claude Code's permission system (interactive prompt / `--allowedTools`), not MCP annotations | **verified**: governed by codex approval/sandbox policy — headless `exec` auto-cancelled the write until `sandbox_mode=danger-full-access` + `approval_policy=never` | client-dependent |
| Tool availability late in a long conversation | unverified — a full-length smoke has still never been measured end to end. Real sessions have run since launch, but nothing in the record establishes tool availability late in one, so this stays open rather than being marked green by association | **verified**: tools persist for the session | **verified**: tools persist for the session | client-dependent |
| Token refresh / long-lived link | **verified** 08-31 — authenticated tool calls from the same connector are in the Loki record on 08-30 and 08-31, days after the 08-26/27 authorization, with no re-consent in between | **verified** 08-26: silent refresh after 10-min token expiry, rotation honored (server `refresh_rotated`) | unverified (session outlived no token in test) | client-dependent |
| Reconnect after expiry | **verified** 08-31, implied by the row above — the 1h access tokens had long expired, so those calls rode a refresh; not driven as an isolated test | **verified** 08-26: post-expiry call succeeds, no user interaction | unverified | client-dependent |
| In-chat file attachment → tool args | **works through ChatGPT Work / the Codex apps pipeline since 2026-09-06, as a host upload of a path the model passes** — four hydrated `open_photo_drop` calls (09-06, 09-08, 09-09 ×2), every one under the Codex-apps `_meta` signature (`callId`, `itemId`, `progressToken`, no `openai/userAgent`); that host shows the model `image` as a string plus "provide the absolute path to that file here", uploads the file and substitutes the handle (argument channel; the `_meta["openai/fileParams"]` channel has never been observed). Nothing is forwarded automatically anywhere: GPT-5.x on ChatGPT web (08-31, 09-01, 09-03) and the iOS app (09-07 ×3) sends nothing, and on 09-09 the Work session sent nothing when the model obeyed our "never … a file path" over the host's sentence (2026-09-09 section). The upload link stays the fallback: the photo drop (ADR-014) for a live smoke, the one-time link for a saved one | **unsupported** — Claude cannot place attachment bytes into tool arguments (Anthropic tracker) | **unsupported for a custom MCP server — verified in source 2026-09-09**: both halves of the adapter (schema masking at listing, upload at call) are gated on the server name `codex_apps`, so a user-configured server publishes `image` as the object and nothing uploads. Through the `codex_apps` server (ChatGPT Work) it is the route that works — see the ChatGPT column | **unsupported** — MCP has no file-input primitive; SEP 2356/1306 unratified |

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
PRD-003 R-MCP-1/-2; the optional `confirmedDistinct` on `add_cigar` and then on
`record_purchase`, and the same-turn sentence in `add_smoke_photo`'s description)
reach
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

**2026-08-31 — additive `record_purchase` schema change.** `record_purchase`
gained the same optional boolean `confirmedDistinct` (default false = unchanged
behavior), on its `described` branch, with `add_cigar`'s semantics exactly. It
removes the detour that made a sampler of related-but-distinct sticks cost a
`search_cigars` → `add_cigar(confirmedDistinct)` → `record_purchase(cigarId)`
triple each: on `cigar_ambiguous` the model confirms with the user and re-issues
the purchase itself. Additive and backward-compatible, and subject to the same
per-conversation schema cache — a retest needs a **connector refresh and a new
chat**, or ChatGPT keeps serving the pre-change schema and cannot pass the field.

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

*Amended 2026-08-31.* The turn-recency hypothesis is now stated model-facing after
all — one sentence in the tool description and one in `INSTRUCTIONS` — but as odds,
not as fact, and never ahead of the link (tool-contract.md, "Amended 2026-08-31").
The distinction that made the earlier draft wrong survives intact: that one fired
on `no_image_received` and delayed the link; this one is standing advice about how
to attach a photo, and ends by naming the link as the path that works either way.
The prompt was a session on 2026-08-31 where the user's photo was attached several
turns before the call and nothing was forwarded.

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

## 2026-09-01 — experiment 2 spent: same-turn attachment forwards nothing; the photo drop

The retest above ran, under the conditions both experiments asked for: strict
reference schema deployed (#204), fresh chat, and the image attached to the
**same message** that asked for the photo. The `add_smoke_photo` call for smoke
`04869501-…` (2026-09-02T01:36:17Z) recorded:

```
paramKeys:      ["_meta","arguments","name"]
argKeys:        ["kind","smokeId"]
argImage:       absent
metaKeys:       ["openai/locale","openai/organization","openai/session","openai/subject","openai/userAgent","openai/userLocation","timezone"]
metaFileParams: {"type":"absent"}, count 0
```

Nothing on either channel, no undeclared key. The published shape was never the
cause and the invoking turn was not the variable; both of #202's experiments are
spent, and developer-mode connectors being gated out of `openai/fileParams` stands
as the explanation for practical purposes. The upload-link fallback then attached
the photo first time (photoId `191eb2d4-…`, 1080×1440).

**What changed because of it.** The "attach it in the same message" advice is
withdrawn from the tool description and the server instructions — it cost a
re-attach for a path now shown not to fire. The strict `image` schema stays: it is
the reference shape and reverting would only restore a lenience no host exercises.
And the same session showed the real problem was never forwarding: the user had
sent the photo in the first third and was asked at the end to find and send it
again, because `add_smoke_photo` needs a `smokeId` that exists only after the
save. ADR-014 answers that with the **photo drop** — `open_photo_drop` mints a
48-hour, multi-photo link the moment a photo appears; `save_smoke { photoDropId }`
claims it. The photo is added once, when it is taken, on every client.

**Residual for the upstream report:** the Loki signature above is the evidence
base. Mode A stays implemented on both photo tools.

## 2026-09-03 — the third data point, and forwarding stops reading as a failure

Three `open_photo_drop` calls (01:04:08Z, 01:18:09Z, 01:21:46Z) recorded the same
signature a third time — `paramKeys ["_meta","arguments","name"]`, `argKeys []`,
`argImage absent`, `metaFileParams {"type":"absent"}` count 0,
`photo_intake outcome no_delivery, channel none, mode upload_url` — and the
upload link then carried the photo (`photoId 10edfb52-…`, 1080×1440). Nothing new
about the mechanism; the value is that the drop's own tool now shows it, with no
`image` argument published for a model to fill.

**What changed because of it (#288).** The wording, not the intake. The
`delivery.detail` for `no_image_received` reads, in its current form

> No image arrived with this call. When the host forwards an attached photo it is
> stored directly; when it does not, the upload link is the path — relay it. This
> is a normal outcome, not a failure.

and `open_photo_drop` / `add_smoke_photo` each carry one sentence telling the model
to relay the link and not report `no_image_received` as a problem. (The 09-03
wording said no current client forwards; 09-06 falsified that and it was replaced —
see the section below.) The old sentence ("No image arrived with this call.") was
true and read as a fault, which cost the owner a turn of the model apologizing
before it relayed the link that works.

**Additive surface.** One new tool, `open_photo_drop`, on the existing
`journal:write` scope — no new scope, so a connector token already minted reaches
it with no re-consent — plus two **optional** arguments: `save_smoke.photoDropId`
and `add_smoke_photo.photoDropId`. Omitting both is exactly the behavior that
shipped before: no drop is claimed, `add_smoke_photo` mints its one-time link,
and no existing schema changes shape (R-MCP-4). The ChatGPT per-conversation
schema cache applies as always — the new tool and the two arguments reach an
in-flight conversation only after a connector refresh and a new chat, and until
then a `photoDropId` fails validation client-side rather than reaching the server.

## 2026-09-06 — forwarding observed

The first hydrated file input this server has ever received. Owner session on the
**Astra** model in the ChatGPT iPhone app, prod v0.42.0, from Loki
(`photo_intake_request` / `photo_intake`):

```
01:40:49Z open_photo_drop  argKeys ["image"]  argImage object, filled
                           download_url, file_id, file_name, mime_type
                           metaFileParams {"type":"absent"}, count 0
          photo_intake     outcome attached, channel argument, mode attached
                           fetched sdmntprcentralus.oaiusercontent.com 200,
                           170,310 bytes, image/jpeg declared and sniffed, 142 ms
01:44:39Z open_photo_drop  argKeys []  argImage absent  metaFileParams absent
          photo_intake     outcome no_delivery, channel none, mode upload_url
```

`metaKeys` on both: `callId, itemId, openai/organization, openai/session,
openai/subject, openai/userLocation, progressToken` — a different signature
from ChatGPT web's, which carries `openai/locale`, `openai/userAgent` and
`timezone` and none of `callId`, `itemId`, `progressToken`.

**What it settles.** Mode A works end to end: this model hydrates the strict `image`
schema through the **argument** channel, the server fetched and stored the file, and
the photo landed on the smoke. The declaration and the published shape were never
the cause of the three earlier misses — those were host-side — and the upstream
question sharpens from "is hydration gated?" to "why does the same connector get its
file input hydrated on the Astra model and never on GPT-5.x?". The
`_meta["openai/fileParams"]` channel remains unobserved on any client.

**What stays.** The upload link keeps leading in the tool descriptions and the
server instructions, because every other host measured forwards nothing and the
same host forwarded nothing on its own next turn. The `photo_intake_request` probe
and its logging stay — they are what separates a host that forwards from one that
does not. And `no_image_received` stays a normal outcome, not a failure; only the
claim that no client forwards was removed from the copy.

**Follow-up (2026-09-07).** The probe recorded that `openai/userAgent` *existed*
and never its value, so the two signatures above could be told apart only by
guessing from `metaKeys`. `photo_intake_request` now carries
`client: { id, userAgent }` — the resolved OAuth client and that header's value,
each bounded to 64 characters and the only `_meta` value ever logged
(security-and-observability.md).

**2026-09-07/08 — forwarding is gated by the model, not the app.** With the
`client.userAgent` value logged (#315), the surface that never forwards has a
name: `ChatGPT/1.2026.237 (iOS 26.6.1; iPhone18,4; build 33230022603)` running
GPT-5.6. On 2026-09-07 — 03:35, 14:34 and 23:30 UTC, the last after a connector
re-import — its `open_photo_drop` calls carried `argKeys: []` and no
`openai/fileParams`, with `_meta` keys `openai/locale, openai/organization,
openai/session, openai/subject, openai/userAgent, openai/userLocation,
timezone`. The owner then confirmed (2026-09-08) that the two forwards of
2026-09-05/06 were the **Astra** model on the same iPhone app: full file object
hydrated, `_meta` keys `callId, itemId, progressToken, …` — a signature that
shares nothing with GPT-5.6's. Same app, same connector, same OAuth client; two
tool-call pipelines. Astra is priced out of daily use, so under GPT-5.x
`no_image_received` is the expected result of every call and the relayed link is
the workflow: it staged the photo 37 s and 41 s after the mint on the 14:34 and
23:30 runs, and GPT-5.6's own account of the 23:30 run (a bug report it wrote
against its host) agrees — image visible to the model, nothing forwarded, schema
correct. Nothing server-side to fix. Re-test when the model changes, not the app
build; an Astra call will show its signature on `photo_intake_request` (its
`_meta` carries no `openai/userAgent`, so expect `client.userAgent: null`).

## 2026-09-09 — the Work host uploads a path the model passes; our copy forbade it

**The incident.** ChatGPT Work (tools reached as `mcp__codex_apps__cigar_journal_*`
through a `functions.exec` cell), Tatuaje Monster Smash Drac, the photo attached
in the conversation. The model called `open_photo_drop({})` — it omitted `image`
because the tool description told it to — and the server said
`no_image_received`; the owner uploaded through the link 23 minutes later.
The night before, the same surface had forwarded three photos.

| UTC | tool | argKeys | argImage | `_meta` keys | `photo_intake` |
|---|---|---|---|---|---|
| 09-08 16:37:10 | `open_photo_drop` | `["image"]` | object, all four filled | `callId, itemId, openai/organization, openai/session, openai/subject, openai/userLocation, progressToken` | `attached` / `argument` — 170,904 B image/jpeg |
| 09-09 03:42:48 | `open_photo_drop` | `["image"]` | object, all four filled | same | `attached` / `argument` — 156,777 B |
| 09-09 03:55:29 | `open_photo_drop` | `["image","photoDropId"]` | object, all four filled | same | `attached` / `argument` — 193,099 B |
| **09-09 21:52:27** | `open_photo_drop` | **`[]`** | **absent** | **same** | **`no_delivery` / `none` / `upload_url`** — drop `40e7b755` |
| 09-09 22:15:19 | `[web] photo_drop_upload` | — | — | — | `staged` 104,003 B 1080×1440, iPhone Safari, via the link |

`client.userAgent` is `null` on all four MCP calls and `client.id` is the one OAuth
client. **Same host signature, four calls, one difference: whether `image` was
sent.** Intake is synchronous, so the empty call could not have been a forward
that landed late; the 22:15 photo is the link.

**The mechanism, from the codex source** (`openai/codex` at `eb680c0`, 2026-09-09;
the client half — the hosted `codex_apps` server that republishes connectors is
not public, so its inheriting this behaviour is an inference from the gates below):

- *Listing.* `codex-rs/codex-mcp/src/codex_apps/file_params.rs` reads the tool's
  `_meta["openai/fileParams"]`, then rewrites each named property in the
  **model-facing** schema: keeps the server's description, appends "This parameter
  expects an absolute local file path. If you want to upload a file, provide the
  absolute path to that file here.", clears every other keyword, and sets
  `type: "string"`. The model never sees our object. Before rewriting it records
  whether the original object accepts `mime_type` / `file_name` (ours does).
- *Call.* `codex-rs/core/src/mcp_openai_file.rs`, invoked from `mcp_tool_call.rs`
  before `tools/call` is sent: for each declared param whose argument is a string,
  read the file (relative paths resolve against the cwd), upload it to the ChatGPT
  backend (`POST /files` → blob PUT → `POST /files/{id}/uploaded`), and substitute
  `{ download_url, file_id, mime_type, file_name }` — the last two only when the
  server's schema accepts them. A non-string value is passed through verbatim.
- *Bad path.* A missing, unreadable or sandbox-denied file fails the **whole tool
  call client-side** ("failed to upload `…` for `image`: …"); no upload starts and
  no `tools/call` reaches the server. So a path the model passes never arrives here
  as text, and a missing file is never reported as `no_image_received`.
- *Gate.* Both halves run only for the server named `codex_apps` ("Disallow custom
  MCPs from uploading files via fileParams"). A custom server in the Codex CLI gets
  the object schema and no upload.
- *Nothing is automatic.* The upload has exactly one caller and it only reads a
  value already in `arguments`. An attachment reaches the model as an inline image
  plus an `<image name="[Image #1]" path="/abs/path">` tag — or, when the read
  fails, "Codex could not read the local image at `…`: …", which is the first line
  the 09-09 conversation showed. The only route to a forwarded file is the model
  typing that path into `image`.

**Who wrote each sentence the model read.**

| Text the model saw | Owner |
|---|---|
| "Leave the image argument empty — never fill in a URL, an id, or a file path." | this repo, both tool descriptions, v0.43.0–v0.45.0 |
| "…Leave it empty: never paste a URL, an id, or a local file path here. A host that can upload a local file fills it itself…" | this repo, the `image` argument, v0.43.0–v0.45.0 |
| "This parameter expects an absolute local file path. If you want to upload a file, provide the absolute path to that file here." | the Codex client, appended at listing time |
| "delivery.status no_image_received is the normal outcome on every current client" | this repo, **v0.43.0 only** (removed by #311 in v0.44.1, 2026-09-07 01:13Z) |

That last row dates the connector's schema: ChatGPT's app catalog snapshotted our
`tools/list` between v0.43.0 (2026-09-06 22:00Z) and v0.44.1 and has served that
copy since — this pod's own `~/.codex/cache/codex_apps_tools` holds the identical
text, fetched 2026-09-06 23:21Z. Prod today publishes #311's wording. A copy fix
therefore reaches Work only after the app is **re-linked or refreshed**; until
then the model keeps reading the v0.43.0 prohibition.

**Cause, confirmed.** The repository's own copy forbade the one value that makes
this host forward — "never … a file path", strengthened in #304 on the day the
first forward had just happened — while the host appended the opposite. On 09-08
the model followed the host; on 09-09 it followed us. Nothing in the server's
intake, declaration or published shape changed between the calls.

**What changed (this PR).** Both tool descriptions, the `image` argument and the
server instructions now say the same thing in three registers: pass the
attachment's path in `image` only when the host states the argument takes one (it
then uploads the file); otherwise leave it empty and never invent a URL, an id or
a path. `no_image_received`'s detail names the retry that works — call again with
the path the host reported — and otherwise the link. A retry inside the session
lands on the same drop and mints another link beside the first (#316); the intake
and the published shape are untouched, because the shape is what the host's
walker reads and what has hydrated four times. Tests pin the affirmative clause on
every surface and pin the old prohibitions *absent*, and cover the retry sequence
(same drop, one photo, both links alive, `kind: cigar`) and a raw path arriving as
text (refused before the handler, probed as `argImage.type: "string"`, never
`no_image_received`).

**Client comparison (2026-09-09).**

| Client | Model supplies | Host transformation | Server receives | `delivery` | Photos | Evidence |
|---|---|---|---|---|---|---|
| ChatGPT Work / Codex apps, path passed | `image: "/workspace/…/upload/IMG.jpeg"` | reads + uploads, substitutes the four-field handle, `_meta` `callId/itemId/progressToken` | object, all four filled | — (`staged`) | 1 | **live**, Loki 09-08 16:37, 09-09 03:42, 03:55 |
| ChatGPT Work / Codex apps, `{}` (the incident) | nothing | nothing to upload | `argKeys: []` | `no_image_received` | 0, then 1 via the link | **live**, Loki 09-09 21:52 + 22:15 |
| ChatGPT Work, path to a missing file | `image: "/…/missing.jpeg"` | call fails client-side, no `tools/call` | nothing | — | 0 | **source-verified** (`openai_file_mcp.rs` test), not exercised live |
| ChatGPT web / iOS app, GPT-5.x | nothing (no path exists to pass) | none | `argKeys: []` | `no_image_received` | via the link | **live**, 08-31 … 09-07 |
| Claude Code / claude.ai | nothing (object schema, no host sentence) | none | `argKeys: []` | `no_image_received` | via the link | **live** for the link path; a Claude call with `image` unset is the mocked `{}` case |
| Codex CLI, custom MCP server | nothing | none — adapter gated to `codex_apps` | `argKeys: []` | `no_image_received` | via the link | **source-verified** gate; not driven live |
| Any host passing a raw path as text | `image: "/abs/path"` (string) | none | string, refused by the strict schema before the handler | `isError` validation result | 0 | **mocked** (mcp.test.ts) |
| Retry in session with a handle | `image` handle after a bare call | n/a | object | — (`staged`) | 1, same drop, links A and B both valid | **mocked** (mcp.test.ts) |

**What is not verified.** The model behind each Work call is not visible server-side
(the owner attributes the successful forwards to Astra; the 09-09 miss carries the
identical host signature, so the signature identifies the pipeline, not the
model). Whether the attachment's copy existed on the host at 21:52 is unknown —
the conversation showed both a read error and a later notice for the same path,
and no call with the path was made, so it was never tested. No live Work or Claude
call was driven from this pod for this fix: the owner's live drop was inside the
session gap, so any `open_photo_drop` under his token would have landed in it.
**What would prove it fixed:** after the app is refreshed in Work, a
`photo_intake_request` for an `open_photo_drop` with `argKeys: ["image"]`, all
four fields filled, `photo_intake outcome attached channel argument` — on a turn
where the model was given the path — and, for the fallback, `argKeys: []` followed
by the link, with the model relaying the link without reporting a problem.

## 2026-08-31 — gap-fill hardened: the two-call path, stated as an invariant

The server `INSTRUCTIONS` "Gap-fill" paragraph and `add_cigar`'s tool description
were rewritten (issue #177). The instruction already read "fill the gap first …
the later `save_smoke`", and a client obeyed the first half only: on 2026-08-30
the owner asked for a journal entry, the catalog lacked the cigar, `add_cigar`
ran, and **no `save_smoke` ever followed** — a catalog row that reported success
and dropped the entry. Nothing in the text said the request was unfinished until
the second call ran.

`add_cigar` → `save_smoke` remains the documented path (owner ruling, 2026-08-31).
What changed is that the invariant is now stated: gap-fill is a prelude, never the
answer; the request is not complete until the `save_smoke`/`record_purchase` that
motivated it has run in the same turn; and a catalog row with no journal entry is
worse than no row at all, because it looks like success. `add_cigar`'s result
carries `journalEntryCreated: false` so a client that never reads the preamble
still meets the invariant at the point of use, and `save_smoke`'s result gains
`enrichmentQueued`.

**Two behaviour changes, neither purely additive.** First, a conversational
`save_smoke` that *creates* a described cigar now also files an
`enrichment_requests` row — a new DB write on a path that previously made none. It
is gated to exactly that case (created + `described` + `llm-conversation`
provenance), so the legacy importer and the web form are untouched, and it can
never cost the entry: the queue attempt runs in a savepoint, and a failure returns
`enrichmentQueued: false` with the smoke saved.

Second — and this one *removes* a write — `record_purchase` now queues enrichment
only when the described name **created** the catalog row. A described purchase that
linked to an existing row used to file a request; it filled no gap, so it no longer
does, matching `save_smoke`'s gate. That queue also moved to *after* the ledger
insert and into the same savepoint: it previously ran first and unguarded, so a
failing enrichment aborted the transaction and the purchase was lost with it (zero
purchase rows, zero cigar rows). No response field changes — `record_purchase` does
not report `enrichmentQueued` — so a client sees only the durability improvement.

The schema changes themselves are additive: one new output field on `add_cigar`,
one optional field on `save_smoke`.

**This is inert on the surface where it failed until the owner acts.** Per the
manifest-cache section above, ChatGPT caches tool descriptions globally and input
schemas per conversation: the rewritten instruction and the new result field reach
it only after a **connector refresh AND a new chat**. The conversation in which the
loss happened keeps the old preamble and can repeat the loss verbatim. Nothing
server-side can force the refresh.

## 2026-08-31 — additive taxonomy curation verbs (admin only, ADR-012 Wave 3)

The curation surface gained four writes on the existing `curation:write` scope
(issue #196): `register_taxonomy`, `update_registry_aliases`,
`assign_cigar_taxonomy`, `split_cigar`. `get_curation_queue` gained two kinds,
`unlined` and `unblended`, and its `unbranded` kind now keys on the `brandId`
link rather than the free-text `brand` column — a behavior change for that kind,
which now surfaces rows that carry a brand spelling but no registry link.

**No new scope.** The four ride `curation:write`, so an already-minted curation
service token reaches them with no re-consent — unlike the wave-4a surface, which
introduced the `curation:*` pair. `CURATION_SERVICE_SCOPES` is unchanged.

**Existing clients are unaffected** (R-MCP-4): the seventeen journal/catalog tools
and their schemas are untouched, and a normal connector token never carries
`curation:*`. For ChatGPT specifically, the per-conversation schema cache applies
as always — the two new queue kinds reach an in-flight conversation only after a
connector refresh and a new chat, and until then `kind: unlined` fails schema
validation client-side rather than reaching the server.

## 2026-09-01 — additive: `set_listing_match_status` takes a reason (admin only)

`set_listing_match_status` gained one **optional** enum argument,
`unmatchedReason` (`market_refusal` | `no_match` | `no_anchor` | `ambiguous`),
and its result gained the matching field (issue 245). No new tool, no new scope,
no change to any journal/catalog schema.

**Additive in the strict sense** (R-MCP-4): omitting it is the behavior that
shipped before — the unmatch is recorded with no reason. What is new is that
omission is now *meaningful* rather than the only option, since ADR-006's
2026-09-01 amendment lets the enrich drain supersede a reasonless agent unmatch
and never a reasoned one. A caller that never learns the argument exists keeps
working exactly as it did.

The ChatGPT per-conversation schema cache applies as always, and for once it
costs nothing: the only caller is the dev-env-ops curation lane, which registers
this server per session and so always holds the current schema. A stale in-flight
conversation would reject `unmatchedReason` client-side rather than reach the
server — but the tool needs `curation:write` plus an admin principal, which no
connector token carries.

## Workflows

**Primary (shipped, in daily use):** the user talks to ChatGPT normally for the
whole smoke; on "that's it," the model calls `save_smoke`. This is how entries
are written — reads *and* writes from normal Chat, no confirmation friction —
and the journal's own record shows conversational smokes alongside the imported
archive. Remaining watch item, unchanged: connector availability across a very
long conversation (matrix row above).

**Photos take a link, unless the model forwards.** Only ChatGPT on the **Astra**
model has ever placed an in-chat attachment into tool arguments, first on
2026-09-06; every other model and client measured forwards nothing (matrix row,
and the dated sections below). During a smoke the model opens a photo drop
(`open_photo_drop`, ADR-014) as soon as a photo appears and the user adds each
photo to it once; `save_smoke` claims the drop. For a smoke that is already
saved, `add_smoke_photo` returns a one-time upload link.

**Fallback (if a client loses write tools):** the model produces the exact
`save_smoke` payload as text; the user pastes it into the site's import page
or hands it to a write-capable client (Claude Code / Codex) to invoke
verbatim. Same schema, same validation (tool contract, fallback section).

**Alternate full clients:** Claude Code and Codex both proved the complete
read + write workflow against the identical server. The product's UX model
remains a normal conversational assistant; MCP schemas stay optimized for
conversational tool use, not coding-agent automation.

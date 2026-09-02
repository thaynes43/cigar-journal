# ADR-014: Photo drop — a smoke's photos are collected before the smoke exists

- **Status:** accepted
- **Date:** 2026-09-01

## Context

A live smoke is journaled as one `save_smoke` at the end (ADR-002, flow 001).
Photos are taken during it. `add_smoke_photo` binds to a `smokeId`, so until
the save there is nothing to attach to, and the 2026-09-01 Atabey Black Ritos
session ended the way every live smoke would: the user had sent the cigar
photo in the first third, and at the end was asked to find it and send it
again so the tool could mint a link for it. Two sends of one photo, the second
at the moment they have moved on.

The in-chat attachment does not reach the server and the design may no longer
assume it will. The `photo_intake_request` probe recorded the same session's
`add_smoke_photo` call, made with the image attached to the *same message*:
`argImage: absent`, `metaFileParams: absent` (count 0), no undeclared keys.
That was issue #202's second and last experiment; the published schema was
never the cause, and developer-mode connectors being gated out of
`openai/fileParams` is the standing explanation. No other host has a
mechanism at all ([client-compatibility.md](../mcp/client-compatibility.md)).
The upload link is the only path that works, on every client.

So the problem is not forwarding. It is that the link is bound to a smoke, and
the smoke arrives last.

## Decision

**A photo drop: a link bound to the user's smoke in progress, opened before the
smoke exists, that takes every photo of that smoke until it expires.**

- **`photo_drops`** — one row per drop: owner, the SHA-256 of its URL token
  (at-rest discipline as `photo_upload_tokens`), `expires_at` (48 hours from
  opening), and `smoke_id` + `claimed_at` once a save has claimed it.
  **`staged_smoke_photos`** — the photos dropped before a claim, shaped
  exactly like `smoke_photos` (kind, caption, keys, dimensions) but bound to a
  drop instead of a smoke. Pipeline before persistence, as ADR-007: only
  normalized output reaches the bucket, under `drop/<dropId>/<uuid>.jpg`.
- **The link is multi-use for its lifetime.** A single-use link is right for
  "one photo of a saved smoke"; a live smoke produces several photos over
  hours, and each one is a first-class event the user should not have to
  request a new link for. Single use is not the security weight here — the
  256-bit token is — and the drop is bounded the same way a smoke is: at most
  `MAX_PHOTOS_PER_SMOKE` photos, 48 hours, and a page that shows only the
  drop's own photos.
- **One open drop per user.** `open_photo_drop` returns the user's open
  (unclaimed, unexpired) drop when one exists, with a **fresh token** — the
  raw token is never stored, so reuse rotates it and the earlier link dies.
  This is what makes the drop survive a long conversation: a model that lost
  the id in a two-hour chat opens again and gets the same photos back. The
  cost is that two simultaneous smokes by one user share a drop; the page
  shows what is in it and the user can remove a photo.
- **`save_smoke` claims.** `photoDropId` on the save moves the drop's staged
  photos onto the new smoke and binds the drop to it, so a photo added through
  the same link afterwards lands directly on the smoke until the link expires.
  The claim runs **after the save commits, in its own transaction, and never
  fails the save** (ADR-007 failure isolation: a photo problem is reported in
  the save result, never raised from it). A retried save re-runs the claim; it
  is idempotent. `add_smoke_photo` accepts `photoDropId` too, for a drop the
  save did not carry.
- **Explicit, never inferred.** Nothing claims a drop that the caller did not
  name: the web record form, the legacy importer and a save without
  `photoDropId` leave every drop untouched. "The user has an open drop" is a
  fact the save result may report, not a reason to attach.
- **The model opens the drop when the photo appears, not when the smoke
  ends.** Server instructions and the tool description say so in one
  sentence: the moment a photo is shared or mentioned, open the drop and relay
  the link; hand the same link back for every later photo; pass the id on the
  save. The "attach it to the same message" advice is withdrawn — it was an
  odds-maximizing hypothesis, and the probe has now falsified it. Attached
  delivery (mode A) stays implemented on both tools, at no cost, for the day a
  host forwards a file; `open_photo_drop` stores a forwarded image into the
  drop and still returns the link.
- **Lifecycle without a job.** Uploads stop at `expires_at`; an unclaimed drop
  and its staged objects are swept seven days after opening, lazily, when the
  same user next opens a drop. Deleting a smoke closes its drop
  (`smoke_id` set null): uploads refused, remainder swept.

## Consequences

- The target experience holds on every client: the user adds each photo once,
  when they take it, and it is on the review when the smoke is saved.
- A second anonymous, token-authorized web surface (`/d/<token>` and
  `/api/photo-drops/*`) joins `/u/<token>`; both must stay out of the edge
  session gate and both accept the same trade-off that the token rides the URL.
- `save_smoke` gains a post-commit step for the first time. It is isolated by
  construction (own transaction, own error handling, reported not raised), and
  the invariant that a photo never blocks a save is now tested from both sides.
- `smoke_photos.object_key` may carry a `drop/` prefix for a claimed photo.
  Keys were never load-bearing (ADR-007: authorization at the route), and
  moving objects on claim would trade a row update for two bucket copies and
  two deletes per photo.
- Follow-ups: the record form could offer the open drop ("2 photos waiting")
  as an opt-in — explicit, so it still does not infer.

## Alternatives considered

- A draft/started smoke (`start_smoke` → `finalize_smoke`) — a second Smoke
  lifecycle state would touch every read (journal, public pages, history,
  inventory) to hide drafts, for a problem that is only about media ids.
- `add_smoke_photo` without a `smokeId` returning a staged photo id — the
  reporter's lowest-impact option; rejected because it makes one tool mean two
  things and puts a single-use link on a multi-photo event.
- Auto-claiming the user's open drop on any save — silent attachment across
  web, importer and MCP; rejected for the same reason consumption is never
  inferred (ADR-008).
- Fixing forwarding first — not available to us; the probe has shown the host
  sends nothing regardless of shape or turn.

# Catalog Exclusions — Packaging and Non-Cigar SKUs

Standing record of which catalog rows are deliberately hidden from browse, why,
and how to reverse it. Every count below is re-derived from prod on 2026-08-30
by the query printed beside it. Umbrella issue #127; the durable fix for
packaged SKUs is #164.

Prod at audit time: **970 active / 6 excluded** (`SELECT catalog_status,
count(*) FROM cigars GROUP BY 1`).

## What exclusion does

`excludeCigar` (`packages/domain/src/curation.ts:662`) flips `catalog_status` to
`excluded` and, in the same transaction, cascades the cigar's `auto` listing
links to `unmatched` so the row stops resurfacing in `match_triage`. The detail
page and any owner history stay reachable — exclusion is browse-level, not a
delete.

**It is a one-way door for listings.** `restoreCigar` reactivates the cigar
*only*; it does not re-link the cascaded `listing_matches`. A legitimate link
comes back when the crawler next re-proposes it, and the crawl CronJobs are
suspended pending the #97 unsuspend — so "next crawl" may be far off. Exclude
only rows whose vendor links are worthless.

## Two hard rules, enforced by the gate

Both are properties of the *apply moment*, not of the audit. They live in the
selector and are re-asserted by the pre-apply gate, because the database has a
second writer: the daily curation lane logged 291 `listing_match.set_status`
verdicts on 2026-08-29 alone.

1. **Never exclude a row the owner holds a purchase lot for.** Exclusion hides
   the row from browse, which hides sticks that are physically in the humidor.
   Three samplers were excluded on 2026-08-29 and have since been restored for
   exactly this reason (23 sticks). The curation agent's manual now forbids it
   (haynes-ops#2680); the code-level guard is cigar-journal#169.
2. **Never exclude a row carrying a curated (non-`auto`) vendor link.** The
   cascade at `curation.ts:723-727` is scoped `status = 'auto'`, so a
   `confirmed` link is *skipped* — it survives pointing at a now-hidden cigar,
   and `upsertListingMatch` (`packages/crawler/src/core/match.ts:70`) returns a
   `confirmed` row untouched forever, so no future crawl repairs it.
   `setListingMatchStatus` keeps `cigar_id` on a confirm and nulls it on an
   unmatch (`curation.ts:610`), so `status <> 'auto'` on a still-attached link
   is precisely the dangerous case.

## Selector rule: vendor URL taxonomy, not name regex

Name regexes over-match. The audit that produced the batch below started from
`bundle|mazo|outlet|\ypack\y|\ypk\y|\ydeal\y|[0-9]+\s*cigars|\ytrio\y|[0-9]+\s*ct\y`
over `canonical_name` and caught **`CAO Brazilia Amazon`** — a real $11.89
single-stick Fox listing, matched on the `mazo` inside "A·mazo·n". A bulk apply
would have excluded it.

Select on the vendor's own URL taxonomy instead, and eyeball the result. Cuban
Lou's files packaging SKUs under `/cigar-bundles/`, merchandise under
`/cigar-books/` and `/xikar-cigar-punch/`; only `/cigar-outlet/` needs a name
test on top, because that path also holds real single cigars.

### The regex and the batch are not nested sets

```sql
-- 62 regex hits, 44 selected, 41 in both, 3 selected-only, 21 regex-only.
WITH rx AS (
  SELECT id FROM cigars WHERE catalog_status = 'active'
    AND canonical_name ~* '(bundle|mazo|outlet|\ypack\y|\ypk\y|\ydeal\y|[0-9]+\s*cigars|\ytrio\y|[0-9]+\s*ct\y)'
), sel AS (
  SELECT c.id FROM cigars c
  WHERE c.catalog_status = 'active'
    AND EXISTS (SELECT 1 FROM listing_matches lm WHERE lm.cigar_id = c.id
                AND lm.vendor_id = '2856ad86-5c73-4bee-85b2-22d1816cb8b4'
                AND (lm.listing_key LIKE '/cigar-bundles/%'
                  OR lm.listing_key LIKE '/cigar-books/%'
                  OR lm.listing_key LIKE '/xikar-cigar-punch/%'
                  OR (lm.listing_key LIKE '/cigar-outlet/%'
                      AND c.canonical_name ~* '(bundle|\ydeal\y|[0-9]+\s*cigars|[0-9]+-pack|mix ?& ?match)')))
)
SELECT (SELECT count(*) FROM rx)                                          AS regex_hits,      -- 62
       (SELECT count(*) FROM sel)                                         AS selected,        -- 44
       (SELECT count(*) FROM sel WHERE id IN (SELECT id FROM rx))         AS both,            -- 41
       (SELECT count(*) FROM sel WHERE id NOT IN (SELECT id FROM rx))     AS selected_only,   -- 3
       (SELECT count(*) FROM rx  WHERE id NOT IN (SELECT id FROM sel))    AS regex_only;      -- 21
```

- **3 selected rows the regex never saw**: `The Book of Cohiba`, `The World of
  Habano`, `Xikar 9mm Pull Out Punch` — merchandise, caught only by URL path.
- **21 regex hits deliberately left active**: 17 Fox `… Pack` rows,
  `CAO Brazilia Amazon`, `Cavalier Prospektor Barber Pole Bundle`,
  `Cohiba Siglo IV (Outlet)`, `Montecristo Short (Outlet)`. See
  [Deliberately kept active](#deliberately-kept-active).

So 62 is neither a superset nor a ceiling. It is also an **under**-count:
`\ypk\y` finds no word boundary inside `5pk`, so the two active `5pk` rows never
appeared in it (`SELECT count(*) FROM cigars WHERE catalog_status='active' AND
canonical_name ILIKE '%5pk%'` → 2; the same rows under `~* '\ypk\y'` → 0).
Treat any name-pattern audit as a starting hypothesis, never the answer.

## Pending batch — 44 rows (NOT YET APPLIED)

All 44 come from the 2026-08-29 Cuban Lou's seed. The selector carries both hard
rules, so it can never propose an unsafe row:

```sql
-- vendor_id 2856ad86-5c73-4bee-85b2-22d1816cb8b4 = Cuban Lou's
SELECT c.id, c.canonical_name
FROM cigars c
WHERE c.catalog_status = 'active'
  -- vendor URL taxonomy
  AND EXISTS (SELECT 1 FROM listing_matches lm WHERE lm.cigar_id = c.id
              AND lm.vendor_id = '2856ad86-5c73-4bee-85b2-22d1816cb8b4'
              AND (lm.listing_key LIKE '/cigar-bundles/%'
                OR lm.listing_key LIKE '/cigar-books/%'
                OR lm.listing_key LIKE '/xikar-cigar-punch/%'
                OR (lm.listing_key LIKE '/cigar-outlet/%'
                    AND c.canonical_name ~* '(bundle|\ydeal\y|[0-9]+\s*cigars|[0-9]+-pack|mix ?& ?match)')))
  -- rule 2: no curated vendor link the cascade would strand
  AND NOT EXISTS (SELECT 1 FROM listing_matches lm2
                  WHERE lm2.cigar_id = c.id AND lm2.status <> 'auto')
  -- rule 1: nothing the owner holds inventory for
  AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.cigar_id = c.id)
ORDER BY c.canonical_name;
```

Dropped by rule 1 (purchase lot): **0 of 44**. Dropped by rule 2 (curated
link): **0 of 44**. Both predicates discriminate rather than being vacuous — in
this database they block 83 of the 970 active rows if applied catalog-wide
(82 hold lots, 5 hold a non-`auto` link).

### Pre-apply gate

Run immediately before the first `exclude_cigar` call. **Any failed assertion
aborts the whole batch** — do not apply the passing subset. A count that moved
means a row changed hands since the audit, and the manifest below is stale.

```sql
WITH candidate AS (   -- the URL-taxonomy clause ONLY, without the two rules
  SELECT c.id, c.canonical_name FROM cigars c
  WHERE c.catalog_status = 'active'
    AND EXISTS (SELECT 1 FROM listing_matches lm WHERE lm.cigar_id = c.id
                AND lm.vendor_id = '2856ad86-5c73-4bee-85b2-22d1816cb8b4'
                AND (lm.listing_key LIKE '/cigar-bundles/%'
                  OR lm.listing_key LIKE '/cigar-books/%'
                  OR lm.listing_key LIKE '/xikar-cigar-punch/%'
                  OR (lm.listing_key LIKE '/cigar-outlet/%'
                      AND c.canonical_name ~* '(bundle|\ydeal\y|[0-9]+\s*cigars|[0-9]+-pack|mix ?& ?match)')))
), guarded AS (
  SELECT k.id,
         EXISTS (SELECT 1 FROM listing_matches lm
                  WHERE lm.cigar_id = k.id AND lm.status <> 'auto') AS curated_link,
         EXISTS (SELECT 1 FROM purchases p WHERE p.cigar_id = k.id) AS owner_lot
  FROM candidate k
), g AS (
  SELECT count(*) AS candidates,
         count(*) FILTER (WHERE curated_link) AS curated,
         count(*) FILTER (WHERE owner_lot)    AS lots,
         (SELECT count(*) FROM listing_matches lm
            WHERE lm.cigar_id IN (SELECT id FROM guarded) AND lm.status = 'auto') AS auto_links
  FROM guarded
)
SELECT 'candidates = 44'                  AS assertion, candidates::text AS actual, candidates = 44  AS pass FROM g
UNION ALL SELECT 'curated non-auto links = 0', curated::text,    curated    = 0  FROM g
UNION ALL SELECT 'rows with owner lot = 0',    lots::text,       lots       = 0  FROM g
UNION ALL SELECT 'auto links to cascade = 57', auto_links::text, auto_links = 57 FROM g
ORDER BY pass, assertion;
```

The gate deliberately runs the **unguarded** candidate set so a violation shows
up as a named failure rather than as a row that quietly vanished from the
selector. When it fails, this names the offenders:

```sql
WITH candidate AS (   -- identical to the gate's CTE
  SELECT c.id, c.canonical_name FROM cigars c
  WHERE c.catalog_status = 'active'
    AND EXISTS (SELECT 1 FROM listing_matches lm WHERE lm.cigar_id = c.id
                AND lm.vendor_id = '2856ad86-5c73-4bee-85b2-22d1816cb8b4'
                AND (lm.listing_key LIKE '/cigar-bundles/%'
                  OR lm.listing_key LIKE '/cigar-books/%'
                  OR lm.listing_key LIKE '/xikar-cigar-punch/%'
                  OR (lm.listing_key LIKE '/cigar-outlet/%'
                      AND c.canonical_name ~* '(bundle|\ydeal\y|[0-9]+\s*cigars|[0-9]+-pack|mix ?& ?match)')))
)
SELECT k.id, k.canonical_name,
       (SELECT string_agg(lm.status || ':' || lm.decided_by, ',') FROM listing_matches lm
         WHERE lm.cigar_id = k.id AND lm.status <> 'auto')       AS curated_links,
       (SELECT count(*) FROM purchases p WHERE p.cigar_id = k.id) AS owner_lots
FROM candidate k
WHERE EXISTS (SELECT 1 FROM listing_matches lm WHERE lm.cigar_id = k.id AND lm.status <> 'auto')
   OR EXISTS (SELECT 1 FROM purchases p WHERE p.cigar_id = k.id)
ORDER BY 2;
```

Then diff the selector's ids against the manifest table below and apply only ids
present in both. A non-empty diff **in either direction** is also an abort: a
new row means the seed re-ran, a missing row means one was curated.

Gate result on 2026-08-30: all four assertions pass, offenders empty, diff empty.

| Catalog id | Name | Vendor path |
|---|---|---|
| `048edb99-352b-416d-9a78-0f72caa9a18b` | Alec Bradley Prensado Factory Second Fumas Robustos – Bundle of 20 | `/cigar-bundles/` |
| `c732d375-145e-4779-93d1-4fd063f13726` | Bahia Brazil Toro – Bundle of 20 | `/cigar-bundles/` |
| `8f72f650-472c-43d6-b789-646f354ee434` | Bahia Cafe Robusto – Mazo of 12 | `/cigar-bundles/` |
| `49e675d1-2240-4113-9921-9cdd1277a1ce` | Bahia Maduro Pancho Robusto – Bundle of 20 | `/cigar-bundles/` |
| `cf807b2d-5542-48d2-a408-cf6ca7e49f2e` | CAO Black Bengal Toro – Bundle of 20 | `/cigar-bundles/` |
| `2e31c522-3fce-40e1-927b-0c6cd2111cd6` | CAO Surplus Gigante Shade-Grown Gordo – Bundle of 25 | `/cigar-bundles/` |
| `ad5d4ce5-687f-4fb3-861a-ba5b423d217f` | Camacho Scorpion Fumas Connecticut Gordo – Bundle of 16 | `/cigar-bundles/` |
| `46361cd1-a549-4571-96cd-9e564a457c48` | Club & Mini Outlet Bundle Deal | `/cigar-outlet/` |
| `07c09c34-0a7d-4bb0-88bc-877cbc8bbabb` | Cohiba & Montecristo DOMINICAN Bundle (Outlet) | `/cigar-outlet/` |
| `72b08275-79fe-49da-a34a-1f3e9c31df79` | Cohiba 3-Pack Trio Deal | `/cigar-outlet/` |
| `58cc5aca-e2ed-4ea7-a599-e35b089f6453` | Cohiba Panetelas (Outlet - 23 CIGARS) | `/cigar-outlet/` |
| `12d37349-538e-4075-b548-9eec3474d932` | Cohiba Robustos (Outlet - D - 19 CIGARS) | `/cigar-outlet/` |
| `6bd5993c-70da-4d80-a13b-882c83b8096d` | Dominican Barber Pole Torpedo – Bundle of 20 | `/cigar-bundles/` |
| `bc60b68f-4259-4453-876d-f08197322024` | Dominican Bundles Double Toro Natural – Bundle of 20 | `/cigar-bundles/` |
| `2b73336f-8001-474c-9d15-c8e3fca6b238` | Dominican Bundles Handmade Cheroots Natural – Bundle of 10 | `/cigar-bundles/` |
| `b5b975c5-e132-495e-a915-5162de51cb2d` | Drew Estate Factory Smokes Gordo Sun-Grown – Bundle of 25 | `/cigar-bundles/` |
| `46e7f0e3-14f0-439d-9bdd-e0802b17a492` | Flor de Oliva Robusto Natural – Bundle of 20 | `/cigar-bundles/` |
| `9eb3d20a-2cfc-4498-9067-efaf214abd9a` | Gran Habano Connecticut Vintage 2004 Churchills – Bundle of 20 | `/cigar-bundles/` |
| `9fe3b168-488a-4ed4-a051-f28b5bacc7b7` | Gran Habano Corojo Vintage 2002 XO Gordo – Bundle of 20 | `/cigar-bundles/` |
| `eba9c0bf-d6ee-4913-8781-131cd70a1ee1` | Graycliff 1666 Toro – Bundle of 20 | `/cigar-bundles/` |
| `a6a3c1c2-dc0b-4b59-8377-4a651f914cce` | Graycliff Turbo Edicion Limitada 2010 Toro – Mazo of 15 | `/cigar-bundles/` |
| `48c5eb87-41ec-4e57-ac4e-e36cbbf00feb` | Gurkha Centurian Double Perfecto – Bundle of 20 | `/cigar-bundles/` |
| `8d726d72-65eb-4336-bf05-910935cf72a7` | Gurkha Prize Fighter Robusto – Bundle of 20 | `/cigar-bundles/` |
| `2db56a7d-058d-4dab-b016-8c25255401fa` | Gurkha Sherpa Habano Double Corona – Bundle of 25 | `/cigar-bundles/` |
| `f1153731-bfaf-4814-89f9-01cb5e40b104` | HC Series White Shade Grown Toro – Bundle of 20 | `/cigar-bundles/` |
| `f9db5dc5-b02d-4ec9-945a-688f44eb3b2c` | Hoyo De Monterrey Classic No. 450 EMS Robusto – Bundle of 25 | `/cigar-bundles/` |
| `35e65ad9-3ec8-49f6-9cc0-6b532aca4462` | Jose Marti Magnum – Bundle of 20 | `/cigar-bundles/` |
| `0bc358d6-4486-4139-a7da-bcc42cdd265e` | Mark Twain Memoir No. 2 Gordo – Pack of 20 | `/cigar-bundles/` |
| `00569d06-f622-4bce-b29a-a30180ccc668` | Mix & Match Cuban Cigar Bundle (Outlet) | `/cigar-outlet/` |
| `d51d962f-1c5e-4d9c-8868-e30b01f94959` | Nicaraguan Bundles Box-Pressed Toro Grande – Bundle of 20 | `/cigar-bundles/` |
| `462e0ee9-083f-461c-bba5-332e540171fa` | Nicaraguan Bundles Toro Round Cap – Bundle of 20 | `/cigar-bundles/` |
| `2dc1b3ac-95bf-4938-8c7e-6ff67a5f65f0` | Perdomo Artesanal Sumatra Churchill – Bundle of 20 | `/cigar-bundles/` |
| `4978aa6b-4c95-4970-bc53-6d552d10732e` | Perdomo Fresco Robusto Connecticut Shade – Bundle of 25 | `/cigar-bundles/` |
| `de8cdaed-ef5d-494e-9922-d6a48c8dda0a` | Perdomo Fresco Toro Sun Grown – Bundle of 25 | `/cigar-bundles/` |
| `fdb7b98f-c211-4d20-9c40-4f77489bdb72` | Quorum Churchill Maduro – Bundle of 20 | `/cigar-bundles/` |
| `cc8935aa-9f72-4485-bf5a-d051bbbf32a8` | Quorum Shade Grown Double Gordo – Bundle of 20 | `/cigar-bundles/` |
| `7350042f-6271-4e78-adbe-6b5f671550d9` | Quorum Toro – Bundle of 20 | `/cigar-bundles/` |
| `cd7acdaa-7c52-4707-8157-ef27b3f58f5a` | Rocky Patel Imperial Robusto – Mazo of 10 | `/cigar-bundles/` |
| `413b2a5c-1f8a-4917-bdfc-eacf63b94d6c` | Schizo Robusto – Bundle of 20 | `/cigar-bundles/` |
| `68e31218-0699-46aa-9fa3-b68195f5ef42` | The Book of Cohiba | `/cigar-books/` |
| `2d8395a6-63e2-451b-883c-7e3b3fc48580` | The World of Habano | `/cigar-books/` |
| `ac0d93ae-b10a-4313-81af-1f70e64ef6fa` | Trinidad y Cia Toro – Bundle of 20 | `/cigar-bundles/` |
| `e409e9ae-79ef-4803-abe8-bd7170685957` | VegaFina Fortaleza 2 Robustos - 5 BOX DEAL (Outlet) | `/cigar-outlet/` |
| `d7c5997d-ec0e-499d-a657-3a250322892f` | Xikar 9mm Pull Out Punch | `/xikar-cigar-punch/` |

## Deliberately kept active

- **`Cohiba Siglo IV (Outlet)`**, **`Montecristo Short (Outlet)`** — real
  Habanos in a CC-poor catalog. "(Outlet)" is a merchandising label, not a
  quantity; these want `rename_cigar` (suffix strip), not exclusion.
- **The 11 `/cuban-cigarillos/` rows** (Cohiba Mini, Cohiba Mini LE 2021,
  Cohiba Cohiba Club, Montecristo Club, Montecristo No 2, Montecristo Open Mini,
  Partagas Club, Partagas Mini, Punch Mini, Romeo y Julieta Club, Romeo y
  Julieta Mini Red Aroma) — real machine-made Habanos, the seed's genuine value.
- **`Habanos Seleccion Petit Robustos`**, **`Habanos Seleccion Piramides 2016`**
  — multi-brand assortment boxes, so arguably samplers, but they carry genuine
  collector-edition identity. Undecided, not excluded.
- **`Cavalier Prospektor Barber Pole Bundle`** — Fox prices it at $13.50, a
  single-stick price, so "Bundle" reads as part of the product-line name.
- **The 17 Fox `… Pack` rows**, none of which is a clean exclude:

  ```sql
  SELECT c.canonical_name, count(*) AS links,
         count(*) FILTER (WHERE lm.listing_key !~ '-pack(-[0-9]+)?/$') AS naked_links
  FROM cigars c JOIN listing_matches lm ON lm.cigar_id = c.id
                JOIN vendors v ON v.id = lm.vendor_id
  WHERE c.catalog_status = 'active' AND c.canonical_name ~* '\ypack\y' AND v.name = 'Fox Cigar'
  GROUP BY 1 ORDER BY 3 DESC, 1;   -- 17 rows: 8 with naked_links > 0, 9 with 0
  ```

  **8 are conflations** — the row absorbed the naked single-stick listing too
  (`Davidoff Nicaragua Robusto 4ct Pack` holds
  `/shop/cigars/davidoff-nicaragua-robusto/`; `Deadwood … Promo Pack` holds the
  $12.65 single). Excluding those cascades a legitimate listing to `unmatched`
  and restore will not bring it back. Of the remaining 9, `Davidoff Signature
  2000 Tubos Pack` conflates three *different* packs' listings, leaving **8**
  single-listing packaging SKUs a second batch could safely take. All 17 need
  rename/merge, or the offers treatment in #164.
- **The wider Fox `Tin` / `Tubo` / `5pk` / `N Count` class** — 45 active rows,
  2 of them also in the `… Pack` class above:

  ```sql
  SELECT count(DISTINCT c.id) FROM cigars c
    JOIN listing_matches lm ON lm.cigar_id = c.id
    JOIN vendors v ON v.id = lm.vendor_id
  WHERE c.catalog_status = 'active' AND v.name = 'Fox Cigar'
    AND c.canonical_name ~* '(\ytin\y|\ytubos?\y|5pk|[0-9]+\s*count\y)';  -- 45
  ```

  A packaging variant is arguably a legitimate distinct catalog entry. #164.

## Apply

MCP `exclude_cigar` only — never SQL, never DELETE. Endpoint
`https://cigars.haynesnetwork.com/mcp`, streamable-HTTP: POST `initialize`,
carry the returned `Mcp-Session-Id`, `Accept: application/json,
text/event-stream`. Requires `curation:write` **and** an admin principal.

Capture the baseline (next section), run the gate, then per row `tools/call`
`exclude_cigar` with:

```json
{ "clientRequestId": "<fresh uuid per cigar, reused verbatim on retry>",
  "cigarId": "<id from the table above>",
  "runId": "wo-cigar-bundle-cleanup-20260830",
  "confidence": 0.95 }
```

The shared `runId` groups the batch into one card in the review console's
"Recent agent runs". It is **not** a single-click rollback: `undoCurationAction`
takes one `auditId` (`curation.ts:1757`) and the console renders one Undo button
per row (`admin/catalog/recent-agent-runs.tsx:120`), so reversal is 44 separate
actions — see [Rollback](#rollback). Replaying a call with the same
`clientRequestId` returns `replayed: true` rather than writing twice (ADR-003
envelope).

## Baseline and expected deltas

Another lane writes to this database daily, so the post-apply numbers are
**deltas against a baseline captured immediately before the apply**, never fixed
absolutes. Run this before the gate and again after the last exclude:

```sql
SELECT 'active'         AS metric, count(*) FROM cigars WHERE catalog_status = 'active'
UNION ALL SELECT 'excluded',       count(*) FROM cigars WHERE catalog_status = 'excluded'
UNION ALL SELECT 'match_triage',   count(*) FROM listing_matches lm
                                     LEFT JOIN cigars c ON c.id = lm.cigar_id
                                    WHERE lm.status = 'auto' AND (c.id IS NULL OR c.catalog_status = 'active')
UNION ALL SELECT 'untyped',        count(*) FROM cigars WHERE catalog_status = 'active' AND type IS NULL
UNION ALL SELECT 'unverified',     count(*) FROM cigars WHERE catalog_status = 'active' AND verification = 'unverified'
UNION ALL SELECT 'unbranded',      count(*) FROM cigars WHERE catalog_status = 'active' AND brand IS NULL
UNION ALL SELECT 'missing_photos', count(*) FROM cigars c WHERE c.catalog_status = 'active'
                                    AND NOT EXISTS (SELECT 1 FROM product_photos pp WHERE pp.cigar_id = c.id);
```

`match_triage` mirrors the queue read at `curation.ts:1368`; the other five
mirror `cigarWorklistPage`, which filters `catalog_status = 'active'`
(`curation.ts:1329`).

| Metric | Required delta | Reading on 2026-08-30 | Projected after |
|---|---|---|---|
| active | −44 | 970 | 926 |
| excluded | +44 | 6 | 50 |
| match_triage | −57 | 1,549 | 1,492 |
| untyped | −44 | 884 | 840 |
| unverified | −44 | 918 | 874 |
| unbranded | −35 | 570 | 535 |
| missing_photos | −1 | 62 | 61 |

The middle column is a snapshot for orientation only. **Only the delta column is
a pass condition.** A metric that moved by more than its required delta means
the other lane also wrote; that is not a failure of this apply. A metric that
moved by *less* is — re-run the gate and reconcile before retrying.

Each delta is a property of the 44 rows, reproducible with `count(*) FILTER`
over the selector: 44 are `type IS NULL`, 44 are `unverified`, 35 are
`brand IS NULL`, 1 has no `product_photos` row, and they carry 57 `auto` links.

## Rollback

`restore_cigar` per row with the same `cigarId` and a **fresh**
`clientRequestId` — reusing the exclude's id replays the exclude instead. There
is no run-scoped inverse: 44 excludes need 44 restores (or 44 Undo clicks). The
restore audit self-links the exclude it reverses. Restore is status-only: the 57
cascaded listing links do not come back until the crawler re-proposes them.

## Prior exclusions (6 active, applied 2026-08-29 by the curation lane)

Six Fox gift cards. The same run also excluded `Oliva Free Sampler`,
`LFD Los Tubos Sampler`, and `Drew Estate Free 8-Cigar Sampler` — **wrongly**:
the owner holds a purchase lot on each (10 + 5 + 8 = 23 sticks), so excluding
them hid his own inventory from browse. All three are `active` again as of
2026-08-30. That incident is the origin of rule 1 above.

(The restores carry no `cigar.restore` audit row — `SELECT DISTINCT action FROM
audit_log` shows only `cigar.exclude` — so the reversal is visible in the
current catalog state but not attributable from the audit trail.)

# Catalog Exclusions — Packaging and Non-Cigar SKUs

Standing record of which catalog rows are deliberately hidden from browse, why,
and how to reverse it. Audited against prod 2026-08-30. Umbrella issue #127;
the durable fix for packaged SKUs is #164.

## What exclusion does

`excludeCigar` (`packages/domain/src/curation.ts`) flips `catalog_status` to
`excluded` and, in the same transaction, cascades the cigar's `auto` listing
links to `unmatched` so the row stops resurfacing in `match_triage`. The detail
page and any owner history stay reachable — exclusion is browse-level, not a
delete.

**It is a one-way door for listings.** `restoreCigar` reactivates the cigar
*only*; it does not re-link the cascaded `listing_matches`. A legitimate link
comes back when the crawler next re-proposes it, and the crawl CronJobs are
suspended pending the #97 unsuspend — so "next crawl" may be far off. Exclude
only rows whose vendor links are worthless.

## Selector rule: vendor URL taxonomy, not name regex

Name regexes over-match. The audit that produced the batch below started from
`bundle|mazo|outlet|pack|deal|N cigars|trio|N ct` and caught **`CAO Brazilia
Amazon`** — a real $11.89 single-stick Fox listing, matched on the `mazo` inside
"A·mazo·n". A bulk apply would have excluded it.

Select on the vendor's own URL taxonomy instead, and eyeball the result. Cuban
Lou's files packaging SKUs under `/cigar-bundles/`, merchandise under
`/cigar-books/` and `/xikar-cigar-punch/`; only `/cigar-outlet/` needs a name
test on top, because that path also holds real single cigars.

The same regex is an *under*-count as well: `\ypk\y` finds no word boundary
inside `5pk`, so the Fox `5pk` rows never appeared in it. Treat any name-pattern
audit as a starting hypothesis, never the answer.

## Pending batch — 44 rows (NOT YET APPLIED)

All 44 come from the 2026-08-29 Cuban Lou's seed. Safety cross-checks at audit
time: **0** owner holdings, **0** purchases / smokes / wants / favorites, 43 of
44 carry a product photo, and all **57** listing links are `status='auto'` — so
the cascade destroys no confirmed vendor link.

Reproduce the list before applying; apply only ids present in both the query and
this table, so a row the curation agent has since touched is not swept up.

```sql
-- vendor_id 2856ad86-5c73-4bee-85b2-22d1816cb8b4 = Cuban Lou's
SELECT c.id, c.canonical_name
FROM cigars c
WHERE c.catalog_status = 'active'
  AND EXISTS (SELECT 1 FROM listing_matches lm WHERE lm.cigar_id = c.id
              AND lm.vendor_id = '2856ad86-5c73-4bee-85b2-22d1816cb8b4'
              AND (lm.listing_key LIKE '/cigar-bundles/%'
                OR lm.listing_key LIKE '/cigar-books/%'
                OR lm.listing_key LIKE '/xikar-cigar-punch/%'
                OR (lm.listing_key LIKE '/cigar-outlet/%'
                    AND c.canonical_name ~* '(bundle|\ydeal\y|[0-9]+\s*cigars|[0-9]+-pack|mix ?& ?match)')))
ORDER BY c.canonical_name;
```

Expected effect: active cigars 967 → 923; `match_triage` 1,549 → 1,492;
untyped 884 → 840; unverified 915 → 871; unbranded 570 → 535; missing_photos
59 → 58. Excluded rows 9 → 53.

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
- **The Fox `… Pack` rows.** Nine are *conflations*, not packaging SKUs: the row
  absorbed the naked single-stick listing too (`Davidoff Nicaragua Robusto 4ct
  Pack` holds `/shop/cigars/davidoff-nicaragua-robusto/`; `Deadwood … Promo Pack`
  holds the $12.65 single). Excluding those cascades a legitimate listing to
  `unmatched` and restore will not bring it back. They need rename/merge, or the
  offers treatment in #164.
- **The wider Fox `Tin` / `Tubo` / `5pk` / `12 Count` class** (~30 rows) — a
  packaging variant is arguably a legitimate distinct catalog entry. #164.

## Apply

MCP `exclude_cigar` only — never SQL, never DELETE. Endpoint
`https://cigars.haynesnetwork.com/mcp`, streamable-HTTP: POST `initialize`,
carry the returned `Mcp-Session-Id`, `Accept: application/json,
text/event-stream`. Requires `curation:write` **and** an admin principal.

Per row, `tools/call` `exclude_cigar` with:

```json
{ "clientRequestId": "<fresh uuid per cigar, reused verbatim on retry>",
  "cigarId": "<id from the table above>",
  "runId": "wo-cigar-bundle-cleanup-20260830",
  "confidence": 0.95 }
```

One shared `runId` groups the batch for a single Undo in the review console.
Replaying a call with the same `clientRequestId` returns `replayed: true` rather
than writing twice (ADR-003 envelope).

Post-apply checks:

```sql
SELECT count(*) FROM cigars WHERE catalog_status = 'excluded';           -- 53
SELECT count(*) FROM listing_matches lm LEFT JOIN cigars c ON c.id = lm.cigar_id
 WHERE lm.status = 'auto' AND (c.id IS NULL OR c.catalog_status = 'active');  -- 1492
```

## Rollback

`restore_cigar` with the same `cigarId` and a **fresh** `clientRequestId` —
reusing the exclude's id replays the exclude instead. The restore audit
self-links the exclude it reverses. Restore is status-only: the 57 cascaded
listing links do not come back until the crawler re-proposes them.

## Prior exclusions (9, applied 2026-08-29 by the curation lane)

Six Fox gift cards, plus `Oliva Free Sampler`, `LFD Los Tubos Sampler`, and
`Drew Estate Free 8-Cigar Sampler`. The owner *holds* those three samplers and
his holdings still resolve — evidence that exclusion is browse-level only.

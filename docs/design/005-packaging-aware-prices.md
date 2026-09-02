# DESIGN-005: Prices by packaging — single, pack, box

- **Status:** accepted (owner ruling 2026-09-02: "follow what we see in the
  industry, plenty of sites sell boxes vs singles")
- **Date:** 2026-09-02
- Refines DESIGN-002 §Price and DESIGN-003 §Tile; the rule in ADR-009 stands.

## The miss, named

2 Guys Cigars lists `Liga Privada No9 Belicoso` at $452.60 and `Rough Rider
Toro Maduro` at $169.99 with no packaging word in the name. Before 0.39.1 the
crawler stored those as offers with `packaging: null`, and the detail page
rendered them exactly as stored: a bare figure, no qualifier. A reader takes
$452.60 for the price of one cigar. The tile hid them (per-stick only), which
is right, but hiding is not the design — a box price is real information a
buyer wants, as long as it is called a box price.

What the trade does, surveyed on the shops this catalog already crawls
(Fox Cigar, Small Batch, 2 Guys, Cigars International, JR): the product page
lists the packaging options side by side — **Single**, **5-Pack**, **Box of
20** — each with its price and, on most, the per-stick figure derived from it;
the list or tile shows the cheapest way in, usually the single or "from
$X/stick". Nobody shows a box price without the word "box".

## Rules (additive to ADR-009's "never a bare per-stick")

1. **Never a bare package price either.** A price whose packaging is not
   stated renders with the words `packaging not stated`, sorts last, and is
   never the headline while any packaged offer exists. It stays visible: the
   vendor's listing is still where a buyer can find out.
2. **Tiers, in the order a buyer thinks:** Single → packs (5-pack, 10-pack,
   bundle of N) → Box of N → not stated. Within a tier, best per-stick first;
   in-stock before out-of-stock; then most recently seen.
3. **A box-derived per-stick is labeled as such.** `from $10.50/stick` means
   "if you buy the box"; `$11.59/stick` with no qualifier is only ever a
   single's price. The tile keeps per-stick only, but says `from` when the
   figure came from a multi-stick package.
4. **The headline is two facts, not one:** the best per-stick with its
   packaging, and the cheapest single when one exists. "$10.50/stick · box of
   20 — singles from $11.59" answers both questions a buyer asks.

## Cigar detail — Price section

Replaces DESIGN-002's one-row-per-vendor list with **one block per packaging
tier**, vendors listed inside it.

```
PRICE                                          seen through 2 Sep
from $10.50/stick · box of 20        singles from $11.59

Single                                            $11.59 /stick
  2 Guys Cigars                     in stock · seen 2 Sep    →
  Fox Cigar                         in stock · seen 1 Sep    →   $12.10

5-pack                                             $11.00 /stick
  Small Batch Cigar                 $55.00 · seen 2 Sep      →

Box of 20                                          $10.50 /stick
  2 Guys Cigars                     $210.00 · seen 2 Sep     →
  Fox Cigar                         $224.00 · out of stock   →

Not stated
  Cuban Lou's   unapproved source · packaging not stated    $452.60
```

- Tier heading: the label (`Single`, `5-pack`, `Box of 20`, `Bundle of 10`,
  `Box` when the count is unknown, `Not stated`) on the left, the tier's best
  per-stick on the right (`$X.XX /stick`; omitted for `Not stated`).
- Vendor line: vendor · the package price for multi-stick tiers (`$210.00`) ·
  stock (`in stock` / `out of stock`, unknown omitted) · `seen <date>` · the
  link-out affordance (dropped, with `unapproved source`, for a registry vendor
  without `purchaseLinkout`, exactly as today). Singles show no package price
  (it is the per-stick). A vendor whose per-stick differs from the tier's best
  shows its own per-stick at the right of its line.
- Headline line: `from $X.XX/stick · <packaging>` from the pricing summary's
  `lowest`; when `bestSingle` exists and is not the same figure, ` — singles
  from $Y.YY` follows. When only singles exist the headline is `$Y.YY/stick ·
  single` (no `from`).
- Staleness (DESIGN-002): rows seen more than 30 days ago drop to muted; the
  headline never comes from a stale row while a fresh one exists (already the
  summary's behaviour).
- `Not stated` block: appears only when such offers exist; its rows carry the
  package price at the right and `packaging not stated` in the meta.

## Tile

Unchanged shape (`$X.XX /stick`, muted, subtitle row). One copy change: when
the tile's figure comes from `sticksPerPackage > 1`, it reads `from $X.XX
/stick`. A tile whose only offers are `Not stated` stays priceless, as today.

## MCP / domain

- `CigarPricing` gains `bestSingle: { amount, currency, vendor, seenAt } |
  null` — the cheapest current single-stick offer. Additive; `lowest` is
  unchanged. The tool contract's `get_cigar` pricing example shows both, and
  the model is told: quote `lowest` with its packaging and `bestSingle` as the
  single price; an offer with `packaging: null` is "not stated", never a stick
  price.
- `get_offers` rows already carry `packaging` / `sticksPerPackage` /
  `pricePerStick`; the contract gains one sentence on the null case.
- Offers are ordered as the tiers above (tier, then per-stick).

## Strings (implementers use exactly)

`from $X.XX/stick` · `singles from $Y.YY` · `$Y.YY/stick · single` ·
`Single` · `5-pack` (the stored packaging label when it names its count) ·
`Box of 20` · `Bundle of 10` · `Box` · `Pack` · `Not stated` · `packaging not
stated` · `in stock` · `out of stock` · `seen 2 Sep` · `unapproved source` ·
`community source`.

## Out of scope

Price alerts, per-vendor currency conversion (offers keep their currency and
are shown in it), and a packaging selector on the record-purchase form.

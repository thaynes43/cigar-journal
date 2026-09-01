# Cigar Industry Vocabulary

The trade language the catalog must read, speak, and match against — Cuban and
non-Cuban. It binds enrichment agents, curation, and UI copy (ADR-013 §5).
These are *industry* terms, not domain types: the model is Brand → Line →
Blend → Vitola (ADR-012), and the **maps to** column says where each term
lands. A term with no level is not modeled — record it as evidence or leave it
out; never mint a level to hold it.

Where a fact could not be confirmed it is omitted rather than guessed. Terms
whose only definitions are vendor marketing are marked as such and must never
be stored as provenance.

**This page defines terms; it does not enumerate tokens.** Which words the
matcher treats as a size, a container, a wrapper, or an alternative spelling of
one of those is decided by four sets exported from `@cj/domain` —
`VITOLA_TOKENS`, `PACKAGING_TOKEN_LABELS`, `VARIANT_TOKENS`,
`SPELLING_VARIANTS` — and those sets are the authority (ADR-012 §Decision). A
word is added or removed there, with the tests that pin it; restating them here
would create a second vocabulary to drift against the first.

## Shared

| Term | Meaning | Maps to |
|---|---|---|
| **Vitola** | The size and shape a blend is rolled in. | Leaf `vitola_name` + `length_inches`/`ring_gauge`. Not an entity. |
| **Ring gauge** | Diameter in 64ths of an inch — a 64 ring is exactly one inch, a 50 ring is 50/64 in (≈19.8 mm). | Leaf `ring_gauge`. |
| **Wrapper / binder / filler** | The three leaf roles: the outer leaf, the leaf holding the bunch, and the tobaccos inside. | Blend. A required documentation target on every blend — pursued, never invented. |
| **Strength** | Nicotine impact, distinct from *body* (flavor weight). Both are blend properties, not size properties. | Blend. |
| **Parejo** | The straight-sided cylindrical standard — coronas, panetelas, lonsdales. | Part of the vitola label on the leaf. |
| **Figurado** | Any cigar that is not straight-sided; the catch-all for tapers and bulges. | As above. |
| **Torpedo** | Strictly: closed foot, pointed head, bulge in the middle — but modern usage has drifted to mean any tapered head, so most "torpedoes" sold today are pirámides. The least reliable shape label a crawler meets. | Vitola label; treat as a weak matching token. |
| **Pirámide** | Tapers from a wide **open (cut) foot** to a pointed head. The open foot is what separates it from a torpedo or perfecto. | Vitola label. |
| **Belicoso** | Traditionally a short pyramid whose head tapers more shortly and roundly than a pirámide. | Vitola label. |
| **Perfecto** | Closed at both ends — rounded head, closed foot, usually bulged in the middle. | Vitola label. |
| **Culebra** | Three panetelas braided together, banded as one and unbraided to smoke. | Vitola label; one leaf, sold as a unit. |
| **Salomón** | A large figurado: pointed tapered head over a bulbous foot finished in a nipple tip. | Vitola label. |
| **Diadema** | A very large figurado, generally 8 in or longer, with a closed tapered head; the foot is usually open but varies. | Vitola label. |

## Cuban (Habanos)

| Term | Meaning | Maps to |
|---|---|---|
| **Marca** | The brand, in Habanos' own usage. | Brand. |
| **Vitola de galera** | The **factory** name for a size, standardised across all Cuban factories — one galera name serves many marcas. Robustos (124 mm × 50) is the galera behind both Hoyo de Monterrey Epicure No. 2 and Partagás Serie D No. 4; Mareva is Montecristo No. 4. | Not a level — cross-brand size vocabulary. Keep as matching evidence; there is no global vitola entity. |
| **Vitola de salida** | The **commercial** name on the box — what the buyer asks for. | Leaf `vitola_name`. |
| **Edición Limitada (EL)** | Annual limited production since 2000, on a vitola outside that brand's regular range, using thicker darker wrappers from the upper primings of shade-grown plants, baled at least two years (filler and binder likewise since 2007). Black-and-gold secondary band with the year. An EL is not always permanently retired — H. Upmann Magnum 50 was an EL 2005 and entered regular production in 2008. | Leaf `edition`. |
| **Edición Regional (ER)** | Commissioned by a regional distributor, on a size already in the Habanos portfolio but not in that brand's regular range. The six Global brands (Cohiba, H. Upmann, Hoyo de Monterrey, Montecristo, Partagás, Romeo y Julieta) are ineligible; ERs come from the Portfolio marcas. Red-and-silver *Exclusivo* secondary band naming the region. | Leaf `edition`. |
| **Añejados** | Finished, rolled cigars aged **5–8 years in their original boxes** before release — post-production aging, the opposite axis from leaf aging. Boxes are opened and inspected, stamped *Revisado*, and the cigars get an extra Añejados band. Launched 2015. | Leaf `edition`. |
| **Reserva** | Filler, binder and wrapper all aged **≥3 years in bale** before rolling; black-and-silver second band, numbered boxes. | Leaf `edition`, over the base blend. |
| **Gran Reserva** | The same, with all three components aged **≥5 years**; black-and-gold band stamped *GR*. | Leaf `edition`, over the base blend. |
| **Institutional blending** | Cuba does have named *maestros ligadores* — one per marca — but a blend is approved through a chain no individual owns: factory catadores, a second factory's catadores, then the national *cata general*, under the Comisión Nacional de Degustación's consistency guidelines. Habanos does not market cigars around a blender persona the way non-Cuban brands do. | Blender stays NULL for Cuban blends; blender-level roll-ups are NC-side only, and the UI must not render an empty blender level for Habanos (ADR-013). |

## Non-Cuban

| Term | Meaning | Maps to |
|---|---|---|
| **Master blender** | The individual credited with a blend — a marketed identity on the NC side, unlike Habanos. | Blender, via `blend_blenders`. Credit the blend, not the brand: Willy Herrera has been Drew Estate's master blender since 2011, but Liga Privada (2007) was Steve Saka's, with Jonathan Drew and Nicholas Melillo. |
| **Factory culture** | Blends are identified with a house and its family: My Father Cigars in Estelí, Nicaragua (José "Pepín" García, with son Jaime as master blender); Tabacalera Fernandez, Estelí (A.J. Fernández), plus San Lotano in Ocotal; La Gran Fábrica Drew Estate, Estelí (Liga Privada, the infused ACID line). | No factory level exists in ADR-012 — see *Unsettled*. |
| **Corojo '99** | A Cuban-bred, late-1990s disease-resistant seed varietal succeeding the original Corojo (retired to blue mould and black shank); now widely grown in Nicaragua, Honduras and Ecuador. "Corojo" on a band is not always Corojo '99 — Honduran *Authentic Corojo* is grown from non-hybrid original seed. | Blend wrapper (varietal). |
| **Criollo '98** | From the same Cuban programme, far more blue-mould-resistant; its short broad leaf makes it chiefly a filler/binder leaf in Cuba, though it is grown as a wrapper in Central America. | Blend, by role. |
| **Habano** | On a wrapper: **Cuban-seed tobacco grown outside Cuba** (chiefly Nicaragua, Ecuador) — a seed lineage, not one cultivar. Beware the collision: in Cuba the same word means a cigar made entirely of Cuban tobacco. | Blend wrapper. Disambiguate before storing. |
| **Connecticut Shade** | Grown in the Connecticut River Valley under cheesecloth tents and harvested by priming; thin, supple, near-veinless, golden, used on milder cigars. Much "Connecticut" wrapper sold today is Ecuadorian Connecticut-seed, not Connecticut-grown. | Blend wrapper; record origin and seed separately when both are stated. |
| **Connecticut Broadleaf** | A **different seed**, sun-grown on shorter plants, stalk-cut whole rather than primed, larger and coarser, fermented far longer to a dark brown — the classic maduro wrapper. | Blend wrapper. |
| **San Andrés** | A **growing region**, not a varietal: the San Andrés Valley, Veracruz, Mexico. Its Negro descends from native Cuban black tobacco, is stalk-cut, and darkens nearly black — hence its dominance in maduro. Sumatra seed arrived there separately, in the mid-20th century, and gives a khaki leaf. | Blend wrapper origin; keep varietal separate from region. |
| **Cameroon** | A seed varietal that doubles as an origin label, and the label is loose — the crop runs from eastern Cameroon across the Central African Republic. Distinctively toothy and slightly sweet. Now also grown from Cameroon seed in Honduras and Ecuador. | Blend wrapper. |
| **Sumatra** | A seed varietal named for its origin island, now grown chiefly in Ecuador, Honduras, Nicaragua, the Dominican Republic and Mexico as well as Indonesia; subtle and aromatic, with Ecuadorian Sumatra reading richer. Used chiefly as a wrapper. | Blend wrapper. |
| **Puro** | A cigar blended entirely from one country's tobacco, across all three roles; every Cuban cigar is a puro. **The band is not evidence** — Punch Gran Puro Nicaragua is not one — and in Spanish *puro* just means "cigar". | Derived from the blend's wrapper/binder/filler origins. Never stored as a flag, never read off a title. |

## Commerce terms the crawler meets

Packaging is never identity (ADR-012): these describe an **offer**, not a
product. A packaging variant attaches to the base leaf.

| Term | Meaning | Maps to |
|---|---|---|
| **Box-pressed** | The squared shape from packing round cigars tightly into flat-top boxes and compressing them. | A shape attribute of the leaf's vitola, *not* packaging — but a vendor title carrying it as a descriptor of the same product is not a new leaf. |
| **Trunk-pressed** | A genuinely distinct, more severe press: cigars separated by wooden slats and rotated so all four sides press equally, giving near-square edges. | As above. |
| **Tubo** | A single cigar in a sealed aluminium, glass or wood tube (aluminium ones usually cedar-lined; glass ones also called *crystales*). | Offer packaging. |
| **Cabinet / slide-lid box (SLB)** | A slide-lid wooden box of 25 or 50, cigars typically round and tied with a silk ribbon. Not the same as *semi boîte nature* (SBN), a hinged and clasped cedar box — mapping SLB to SBN mislabels stock. | Offer packaging. |
| **Dress box** | The ordinary wood or cardboard box finished in decorative embossed paper. | Offer packaging. |
| **8-9-8** | Rows of 8, 9 and 8 — 25 cigars in a round-sided box, the round sides existing so the cigars are not pressed square. | Offer packaging. |
| **Bundle** | Economy packaging: cellophane overwrap, no box, usually 25 or 50, traditionally unbanded. It does **not** imply second quality — bundle-exclusive first-quality lines exist. | Offer packaging. |
| **Sampler** | A retailer assortment spanning brands, blends or sizes. Vendor merchandising, with no authoritative definition. | Matches **no single leaf** — a sampler listing goes to triage, never mints a catalog row. |
| **Factory seconds** | Sold as cigars rejected for cosmetic flaws or overproduced, discounted and usually unbanded. **Every available definition is vendor marketing** — no authoritative source defines the term, "seconds" and "overruns" are different claims vendors blur, and the brand behind them is typically undisclosed. | A vendor-declared label on the offer. Never a provenance fact, and never grounds for matching a listing to a branded leaf. |

## Unsettled

- **Factory** has no level in ADR-012. `domain-model-examples.md` still carries
  `manufacturer: { name, factory }` on the leaf, and NC identity is strongly
  factory-shaped ("an A.J. Fernández blend"). Ruled 2026-08-31 (issue #196):
  factory stays a leaf attribute; an entity only if a real use case demands
  one.
- **Vitola de galera** is real, useful matching evidence with nowhere to live,
  since there is no global vitola entity. Matching v2 should decide whether it
  is a token source or a stored alias.
</content>

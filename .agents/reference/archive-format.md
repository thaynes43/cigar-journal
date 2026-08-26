# Archive Ledger Format

Format of the legacy markdown journal in [`archive/`](../../archive/), kept as
the specification for importing it into the application database. Migrated from
the retired `.cursor/rules.mdc`.

## Layout

```
archive/docs/
├── nc-reviews/<brand>/<cigar>.md   # non-Cuban reviews
├── cc-reviews/<brand>/<cigar>.md   # Cuban reviews
├── <section>/index.md              # per-section and per-brand index tables
├── purchase-history.md             # single purchase table
└── cheat-sheet.md                  # wrapper/origin/vitola reference data
```

Folder and file names are lowercase with hyphens (`my-father/le-bijou-1922.md`).
Navigation titles in `archive/mkdocs.yml` are human-readable ("Le Bijou 1922").

## Review pages

```markdown
# <Cigar Name>

## Review <N> - <Vitola> - <M/D/YYYY>

Free-form tasting prose (flavor progression by thirds, construction, burn,
storage conditions).
```

## Brand index tables

| Cigar | Number of Reviews | Date of First Review | Rating |
|-------|-------------------|----------------------|--------|

Rating is 0–100. `Number of Reviews` is maintained by hand and incremented per
added review.

## Purchase history columns

Cigar, Brand, Packaging, QTY, Vitola, Type (NC/CC), Size (L" x RG),
Purchase Date, Humidor Data (date entered humidor), Box Date (CC only),
Retailer, PPS (price per stick).

## Adding an entry (while the archive is still live)

1. Create the review file under the brand folder (new brand: add the folder and
   an `index.md` with the table above).
2. Update the brand's `index.md` table.
3. Add the page to the `nav:` tree in `archive/mkdocs.yml`.
4. Append purchases to `purchase-history.md`.

## Known data quirks (importer beware)

- Column headers drift between brand indexes ("Date First Smoked" vs
  "Date of First Review").
- Brand names drift ("LFD" vs "La Flor Dominicana", "Rockey Patel" typo,
  "Serie B" in purchases vs "Series B 11/16" as a page title).
- Dates appear as both `M/D/YYYY` and `YYYY-MM-DD`; one page title embeds a
  date ("Series B 11/16").
- Some purchase rows use placeholders: `TBD`, `Misc`, `Backordered`, `Stuck`, `-`.

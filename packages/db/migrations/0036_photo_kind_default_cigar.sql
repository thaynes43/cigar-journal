-- 0036_photo_kind_default_cigar — the default photo kind becomes `cigar`
-- (issue #287). Two column defaults, nothing else.
--
-- THE DEFECT. The overwhelmingly common photo of a smoke is the cigar itself;
-- `other` is the fallback. The 2026-09-02 Padrón 1926 live test made the cost
-- visible: the drop-page upload landed as `other` and the owner had to tap
-- `Cigar` on the drop page before saving. The correction was the defect.
--
-- NO BACKFILL, deliberately. An existing `other` row was never a claim the user
-- made about the photo — it is the absence of one — and rewriting it now would
-- invent a claim retroactively. The drop page's chips read the stored value, so
-- an old row keeps saying what it has always said and a fresh upload arrives
-- pre-selected as `Cigar`.
--
-- `photo_upload_tokens.kind` keeps its own `other` default: the single-use link
-- carries the kind the minting call chose, @cj/domain always writes the column
-- explicitly, and the default is unreachable from any shipped path.

ALTER TABLE smoke_photos ALTER COLUMN kind SET DEFAULT 'cigar';

ALTER TABLE staged_smoke_photos ALTER COLUMN kind SET DEFAULT 'cigar';

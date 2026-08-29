-- 0015_product_photo_upload_tokens — extend the single-use upload link to carry a
-- product-photo target (DESIGN-003 §Images wave 5, issue #127). The link table
-- (0007) bound every token to a smoke; a curator now mints a link for a catalog
-- cigar, opens it on a phone, and the upload attaches THAT cigar's product photo
-- (rights 'approved', uploader-asserted). Additive: `target_kind` defaults to
-- 'smoke', so every existing row and every smoke-photo mint is unchanged;
-- `smoke_id` becomes nullable to admit product rows, and a CHECK keeps each row
-- well-formed — exactly one of (smoke_id)/(cigar_id) set, matching its kind. Only
-- admins can mint the product kind (the domain service gates it); the raw token
-- stays the sole authorization, so at-rest discipline (hash only) is unchanged.

ALTER TABLE photo_upload_tokens
  ADD COLUMN target_kind text NOT NULL DEFAULT 'smoke'
    CHECK (target_kind IN ('smoke', 'product')),
  ADD COLUMN cigar_id uuid REFERENCES cigars (id) ON DELETE CASCADE;

ALTER TABLE photo_upload_tokens ALTER COLUMN smoke_id DROP NOT NULL;

ALTER TABLE photo_upload_tokens
  ADD CONSTRAINT photo_upload_tokens_target_shape CHECK (
    (target_kind = 'smoke'   AND smoke_id IS NOT NULL AND cigar_id IS NULL) OR
    (target_kind = 'product' AND cigar_id IS NOT NULL AND smoke_id IS NULL)
  );

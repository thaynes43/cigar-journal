-- 0014_user_timezone — the viewer's preferred IANA time zone (DESIGN-003 §Settings,
-- closing #49's UTC dates). Nullable: an unset zone means "render dates in the
-- viewer's browser-local zone" (the pre-existing LocalDate behavior), so this is a
-- pure add with no backfill. `display_name` (Profile) and `journal_visibility`
-- (Journal) already exist on `users` — Settings v1 needs only this one column.
ALTER TABLE users ADD COLUMN timezone text;

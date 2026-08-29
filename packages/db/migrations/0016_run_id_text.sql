-- 0016_run_id_text — audit_log.run_id was typed uuid (0012) but a run's identity
-- is the dev-env-ops work-order key (e.g. "wo-cigar-curate-20260829"): every
-- curation write from the agent failed the uuid cast as a sanitized
-- `unavailable` (found live 2026-08-29, first curation run; issue #126). The
-- MCP schema is deliberately lenient, so the column follows the real data:
-- text, bounded like other identifier columns. The partial index survives the
-- type change untouched in behavior.
ALTER TABLE audit_log
  ALTER COLUMN run_id TYPE text USING run_id::text,
  ADD CONSTRAINT audit_log_run_id_length CHECK (char_length(run_id) <= 128);

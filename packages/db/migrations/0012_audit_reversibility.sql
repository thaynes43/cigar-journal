-- 0012_audit_reversibility — attribution + reversibility substrate for the
-- curation track (DESIGN-003 §Curation "Attribution + reversibility"). The audit
-- log gains an `agent` actor (the curate batch role — DESIGN-003 wave 4 — writes
-- as `agent`) and three nullable columns that let the review console group and
-- undo agent work:
--   run_id     — the batch run an action belongs to ("Recent agent runs" groups
--                on it; a plain uuid, no FK — there is no runs table yet).
--   confidence — the agent's score for an auto-applied proposal (real, 0..1).
--   reverts    — a self-link to the audit row THIS action undoes; the spine of a
--                real Undo (restore reverts an exclude, unmerge would revert a
--                merge). ON DELETE is left default — the audit log is append-only.
-- All three are nullable and default null, so every existing human-driven caller
-- (`tx.insert(auditLog)`, 16 sites) keeps writing unchanged.

-- Extend the actor CHECK with 'agent'. The constraint was created inline in
-- 0001_init, so Postgres named it `audit_log_actor_check`.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_check
    CHECK (actor IN ('web', 'mcp', 'import', 'system', 'agent'));

ALTER TABLE audit_log
  ADD COLUMN run_id     uuid,
  ADD COLUMN confidence real,
  ADD COLUMN reverts    uuid REFERENCES audit_log (id);

-- The review console reads recent agent work grouped by run and follows the
-- revert chain for Undo. Partial — only agent/undo rows carry these — so the
-- common human-audit write path stays cheap.
CREATE INDEX audit_log_run_idx ON audit_log (run_id, created_at DESC) WHERE run_id IS NOT NULL;
CREATE INDEX audit_log_reverts_idx ON audit_log (reverts) WHERE reverts IS NOT NULL;

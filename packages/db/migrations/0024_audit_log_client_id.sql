-- 0024_audit_log_client_id — record WHICH CREDENTIAL drove a curation write
-- (ADR-011). `audit_log` already answered "who" (`user_id`), "from where"
-- (`actor`) and "in which batch" (`run_id`), but every token a user holds looks
-- identical in it. That made the service-token threat row's claim — "one client
-- per consumer, so a leak is attributable" — untrue for curation writes: a
-- leaked curation token walking `set_listing_match_status` across the triage
-- queue was indistinguishable, afterwards, from the daily lane doing its job.
--
-- Nullable and unconstrained by design:
--   * the web console has no OAuth client, and its rows stay NULL;
--   * no FK to oauth_client — the audit log is append-only history that must
--     outlive the client row it names, and an id stays quotable in an incident
--     record even after the client is gone.
ALTER TABLE audit_log
  ADD COLUMN client_id text;

-- "What did this credential write, and when" — the query an incident starts
-- with. Partial, so the web console's NULL rows (the overwhelming majority)
-- cost nothing.
CREATE INDEX audit_log_client_id_idx
  ON audit_log (client_id, created_at DESC)
  WHERE client_id IS NOT NULL;

-- Partial indexes that remove full table scans from the two hottest read paths.
-- Additive and non-destructive; safe to re-run.
-- Run with:  npx wrangler d1 execute sigaa-caiu-unb-db --local  --file=schema_migration_cache_indexes.sql
--            npx wrangler d1 execute sigaa-caiu-unb-db --remote --file=schema_migration_cache_indexes.sql

-- getLastKnownLayers (db.ts) runs one "WHERE <layer>_status IS NOT NULL ORDER BY
-- timestamp DESC LIMIT 1" per layer on every /api/status request. Without an index
-- matching that predicate, SQLite walks the whole table.
--
-- login_e2e is the pathological case: checkLoginE2E always returns "skipped", which
-- saveCheck stores as NULL, so the query scans every row and finds nothing. The
-- partial index below stays empty, which is exactly the point -- an empty index
-- answers LIMIT 1 in zero reads instead of scanning the table.
--
-- The other three layers stop at the first row today, but go the same way whenever
-- reachability is offline: performHealthCheck short-circuits and the upper layers
-- persist as NULL for the duration of the outage -- i.e. precisely when traffic peaks.
CREATE INDEX IF NOT EXISTS idx_checks_layer_reach
  ON checks(timestamp DESC) WHERE reachability_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checks_layer_portal
  ON checks(timestamp DESC) WHERE portal_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checks_layer_form
  ON checks(timestamp DESC) WHERE login_form_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checks_layer_e2e
  ON checks(timestamp DESC) WHERE login_e2e_status IS NOT NULL;

-- getOpenIncident runs on every /api/status request and on every cron tick. With no
-- incident open -- the normal case -- it scans all of incidents and returns nothing.
-- The table is never pruned (cleanupOldChecks leaves it alone), so it only grows.
-- This index holds at most one entry: the open incident.
CREATE INDEX IF NOT EXISTS idx_incidents_open
  ON incidents(id) WHERE ended_at IS NULL;

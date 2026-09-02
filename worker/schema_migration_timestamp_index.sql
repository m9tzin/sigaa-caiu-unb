-- Time-window index for other_service_checks.
-- Additive and non-destructive; safe to re-run.
-- Run with:  npx wrangler d1 execute sigaa-caiu-unb-db --local  --file=schema_migration_timestamp_index.sql
--            npx wrangler d1 execute sigaa-caiu-unb-db --remote --file=schema_migration_timestamp_index.sql

-- getOtherServiceHistoryRaw filters on "WHERE timestamp >= datetime('now', ?)" with
-- no service_id. The only index on the table is idx_other_service_checks(service_id,
-- timestamp DESC), where timestamp is not the leading column, so the predicate cannot
-- reach it: SQLite falls back to "SCAN other_service_checks" plus a temp B-tree for
-- the ORDER BY.
--
-- Measured against the remote database: the 24h window returned 828 rows and read
-- 30,438 -- the whole table, a 37x amplification -- and 24h is the endpoint's default
-- period. With this index the same window reads 706 rows, and the temp sort
-- disappears because the index already yields the order.
--
-- cleanupOldChecks ("DELETE ... WHERE timestamp < datetime('now','-30 days')") has the
-- same shape and picks this index up as well.
CREATE INDEX IF NOT EXISTS idx_other_service_checks_ts
  ON other_service_checks(timestamp);

-- Other services monitoring table.
-- Run with:  npx wrangler d1 execute sigaa-caiu-db --local  --file=schema_migration_other_services.sql
--            npx wrangler d1 execute sigaa-caiu-db --remote --file=schema_migration_other_services.sql
CREATE TABLE IF NOT EXISTS other_service_checks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  service_id       TEXT    NOT NULL,
  status           TEXT    NOT NULL CHECK (status IN ('online', 'degraded', 'offline')),
  http_code        INTEGER,
  response_time_ms INTEGER,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_other_service_checks ON other_service_checks(service_id, timestamp DESC);

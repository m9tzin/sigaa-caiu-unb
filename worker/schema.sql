CREATE TABLE IF NOT EXISTS checks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  status          TEXT    NOT NULL CHECK (status IN ('online', 'degraded', 'offline')),
  http_code       INTEGER,
  response_time_ms INTEGER,
  error           TEXT,
  -- Per-layer breakdown; each column is nullable because not every layer runs every tick.
  reachability_status TEXT,
  reachability_http   INTEGER,
  reachability_ms     INTEGER,
  reachability_error  TEXT,
  portal_status       TEXT,
  portal_ms           INTEGER,
  portal_error        TEXT,
  login_form_status   TEXT,
  login_form_ms       INTEGER,
  login_form_error    TEXT,
  login_e2e_status    TEXT,
  login_e2e_ms        INTEGER,
  login_e2e_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_timestamp ON checks(timestamp DESC);

-- getLastKnownLayers issues one "WHERE <layer>_status IS NOT NULL ORDER BY timestamp
-- DESC LIMIT 1" per layer on every /api/status request. These partial indexes match
-- that predicate exactly, so the lookup never degrades into a table scan -- including
-- when a layer is skipped for a long stretch and every row stores NULL for it.
CREATE INDEX IF NOT EXISTS idx_checks_layer_reach
  ON checks(timestamp DESC) WHERE reachability_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checks_layer_portal
  ON checks(timestamp DESC) WHERE portal_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checks_layer_form
  ON checks(timestamp DESC) WHERE login_form_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checks_layer_e2e
  ON checks(timestamp DESC) WHERE login_e2e_status IS NOT NULL;

CREATE TABLE IF NOT EXISTS incidents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT    NOT NULL,
  ended_at   TEXT,
  duration_s INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents(started_at DESC);

-- getOpenIncident looks for the single open incident on every request and every cron
-- tick. This partial index holds at most one entry, so the common "none open" case
-- costs nothing instead of scanning a table that is never pruned.
CREATE INDEX IF NOT EXISTS idx_incidents_open
  ON incidents(id) WHERE ended_at IS NULL;

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

-- getOtherServiceHistoryRaw filters on timestamp alone, with no service_id, so the
-- index above -- which leads with service_id -- cannot answer it and the query
-- degrades into a full table scan. This one covers the time window.
CREATE INDEX IF NOT EXISTS idx_other_service_checks_ts ON other_service_checks(timestamp);

-- Pre-aggregated buckets. The aggregate routes used to scan their whole raw window on
-- every cache miss -- /api/stats alone read 60,750 rows per miss, half of the account's
-- entire 5M/day D1 budget. These tables hold the same numbers at three granularities so
-- a miss reads hundreds of rows instead of tens of thousands.
--
-- Sums and counts, never averages: an average cannot be re-aggregated, so a 3-hour
-- bucket built from three hourly ones must compute SUM(sum_x) / SUM(n_x). Each layer
-- carries its own count because the *_ms columns in "checks" are NULL whenever the
-- layer did not run that tick, and AVG() skips NULLs -- dividing by the global n would
-- pull those averages toward zero.
--
-- bucket_start is stored in the same ISO format as checks.timestamp at every
-- granularity, '1d' included (it aligns on T00:00:00Z). See the CUTOFF comment in
-- src/db.ts for why a datetime()-shaped value would compare wrong.
CREATE TABLE IF NOT EXISTS check_rollup (
  granularity         TEXT    NOT NULL CHECK (granularity IN ('15m','1h','1d')),
  bucket_start        TEXT    NOT NULL,
  n                   INTEGER NOT NULL DEFAULT 0,
  n_offline           INTEGER NOT NULL DEFAULT 0,
  n_degraded          INTEGER NOT NULL DEFAULT 0,
  sum_response_ms     INTEGER NOT NULL DEFAULT 0,
  n_response          INTEGER NOT NULL DEFAULT 0,
  sum_reachability_ms INTEGER NOT NULL DEFAULT 0,
  n_reachability      INTEGER NOT NULL DEFAULT 0,
  sum_portal_ms       INTEGER NOT NULL DEFAULT 0,
  n_portal            INTEGER NOT NULL DEFAULT 0,
  sum_login_form_ms   INTEGER NOT NULL DEFAULT 0,
  n_login_form        INTEGER NOT NULL DEFAULT 0,
  sum_login_e2e_ms    INTEGER NOT NULL DEFAULT 0,
  n_login_e2e         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, bucket_start)
);

-- Same idea for the auxiliary services, minus the status counters: the route only ever
-- renders response times (see pivotOtherServiceRows in src/api.ts). No '1d' row -- the
-- other-services chart stops at 30 days and /api/stats does not cover these services.
CREATE TABLE IF NOT EXISTS other_service_rollup (
  granularity     TEXT    NOT NULL CHECK (granularity IN ('15m','1h')),
  bucket_start    TEXT    NOT NULL,
  service_id      TEXT    NOT NULL,
  n               INTEGER NOT NULL DEFAULT 0,
  sum_response_ms INTEGER NOT NULL DEFAULT 0,
  n_response      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (granularity, bucket_start, service_id)
);

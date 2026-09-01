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

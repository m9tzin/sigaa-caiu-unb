import type {
  CheckResult,
  CheckRow,
  IncidentRow,
  LastKnownLayers,
  LayerStatus,
  OtherServiceCheckResult,
  OtherServiceRow,
  RawOtherServiceRow,
} from "./types";
import { OTHER_SERVICES } from "./other-services";
import {
  CHECK_GRANULARITIES,
  SERVICE_GRANULARITIES,
  checkRollupUpsertSql,
  serviceRollupUpsertSql,
} from "./rollup";

/**
 * SQL expression for a time-window cutoff, rendered in the format timestamps are
 * actually stored in.
 *
 * checks.timestamp, other_service_checks.timestamp and incidents.started_at all hold
 * "2026-09-01T12:00:00Z" -- ISO 8601 with a literal T and Z. datetime() renders
 * "2026-09-01 02:07:59" instead, and SQLite compares TEXT bytewise: "T" (0x54) sorts
 * above " " (0x20), so every row from the cutoff's own calendar day compared greater
 * than the cutoff regardless of the hour it carried. A "-24 hours" window silently
 * reached back as far as 48, and cleanupOldChecks under-deleted by up to a day.
 *
 * Measured on the remote database at 03:00 UTC: the 24h window returned 414 rows where
 * 352 were in range, and the 30-day cleanup left 122 rows behind. The error is one
 * partial day, so it grows through the UTC day and peaks just before midnight.
 *
 * The interval stays a bound parameter, so callers keep passing "-7 days" as before.
 */
const CUTOFF = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)`;

// --- Write operations ---

export async function saveCheck(
  db: D1Database,
  result: CheckResult
): Promise<void> {
  // Skipped layers persist as NULL so getLastKnownLayers only picks up ticks
  // where the layer actually ran.
  const skippedToNull = (s: LayerStatus): string | null =>
    s === "skipped" ? null : s;

  // The timestamp used to come from the column DEFAULT. It is bound explicitly now
  // because the rollup upserts below have to land in the bucket that holds *this*
  // check: reading 'now' again in a second statement can cross a bucket boundary.
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const layerMs = [
    result.reachability.responseTimeMs,
    result.portal.responseTimeMs || null,
    result.loginForm.responseTimeMs || null,
    result.loginE2e.responseTimeMs || null,
  ];

  // One batch, so the check and its contribution to every rollup bucket either all
  // land or none do. D1 batches are atomic, which is what makes the incremental
  // upsert safe without a reconciliation pass on every tick.
  await db.batch([
    db
      .prepare(
        `INSERT INTO checks (
           timestamp, status, http_code, response_time_ms, error,
           reachability_status, reachability_http, reachability_ms, reachability_error,
           portal_status, portal_ms, portal_error,
           login_form_status, login_form_ms, login_form_error,
           login_e2e_status, login_e2e_ms, login_e2e_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        timestamp,
        result.status,
        result.httpCode,
        result.responseTimeMs,
        result.error,
        skippedToNull(result.reachability.status),
        result.reachability.httpCode,
        result.reachability.responseTimeMs,
        result.reachability.error,
        skippedToNull(result.portal.status),
        result.portal.responseTimeMs || null,
        result.portal.error,
        skippedToNull(result.loginForm.status),
        result.loginForm.responseTimeMs || null,
        result.loginForm.error,
        skippedToNull(result.loginE2e.status),
        result.loginE2e.responseTimeMs || null,
        result.loginE2e.error
      ),
    ...CHECK_GRANULARITIES.map(g =>
      db
        .prepare(checkRollupUpsertSql(g))
        .bind(timestamp, result.status, result.responseTimeMs, ...layerMs)
    ),
  ]);
}

export async function manageIncidents(
  db: D1Database,
  result: CheckResult,
  lastChecks: CheckRow[]
): Promise<void> {
  const openIncident = await getOpenIncident(db);
  const previousWasOffline =
    lastChecks.length > 0 && lastChecks[0].status === "offline";

  if (result.status === "offline" && previousWasOffline && !openIncident) {
    // 2 consecutive failures: open a new incident
    // Use the previous check's timestamp as the start
    await db
      .prepare(`INSERT INTO incidents (started_at) VALUES (?)`)
      .bind(lastChecks[0].timestamp)
      .run();
  }

  if (result.status !== "offline" && openIncident) {
    // Recovered: close the incident
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const startedAt = new Date(openIncident.started_at).getTime();
    const durationS = Math.round((Date.now() - startedAt) / 1000);

    await db
      .prepare(
        `UPDATE incidents SET ended_at = ?, duration_s = ? WHERE id = ?`
      )
      .bind(now, durationS, openIncident.id)
      .run();
  }
}

export async function cleanupOldChecks(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM checks WHERE timestamp < ${CUTOFF}`).bind("-730 days"),
    db.prepare(`DELETE FROM other_service_checks WHERE timestamp < ${CUTOFF}`).bind("-30 days"),
  ]);
}

export async function saveOtherServiceChecks(
  db: D1Database,
  results: OtherServiceCheckResult[]
): Promise<void> {
  if (results.length === 0) return;

  // Bound for the same reason as in saveCheck: one clock reading for the row and
  // for every bucket it feeds.
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const insert = db.prepare(
    `INSERT INTO other_service_checks (timestamp, service_id, status, http_code, response_time_ms, error)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  await db.batch([
    ...results.map(r =>
      insert.bind(timestamp, r.serviceId, r.status, r.httpCode, r.responseTimeMs, r.error)
    ),
    ...SERVICE_GRANULARITIES.flatMap(g => {
      const upsert = db.prepare(serviceRollupUpsertSql(g));
      return results.map(r => upsert.bind(timestamp, r.serviceId, r.responseTimeMs));
    }),
  ]);
}

export async function getOtherServiceHistoryRaw(
  db: D1Database,
  period: "24h" | "7d" | "30d"
): Promise<RawOtherServiceRow[]> {
  const interval = period === "30d" ? "-30 days" : period === "7d" ? "-7 days" : "-24 hours";
  const result = await db
    .prepare(
      `SELECT timestamp, service_id, response_time_ms
       FROM other_service_checks
       WHERE timestamp >= ${CUTOFF}
       ORDER BY timestamp ASC`
    )
    .bind(interval)
    .all<RawOtherServiceRow>();
  return result.results;
}

export async function getLatestOtherServiceChecks(
  db: D1Database
): Promise<OtherServiceRow[]> {
  // One indexed seek per service instead of a GROUP BY over the whole table: the
  // previous MAX(timestamp) form scanned every row of a 30-day window (~57k) to
  // return one row per service. idx_other_service_checks(service_id, timestamp DESC)
  // answers each of these with a single row. batch() keeps it to one round-trip.
  const stmt = db.prepare(
    `SELECT * FROM other_service_checks
     WHERE service_id = ?
     ORDER BY timestamp DESC LIMIT 1`
  );

  const results = await db.batch<OtherServiceRow>(
    OTHER_SERVICES.map(svc => stmt.bind(svc.id))
  );

  // Services that have never been checked yield no row; callers already treat a
  // missing service_id as "unknown".
  return results.flatMap(r => r.results).sort((a, b) => a.service_id.localeCompare(b.service_id));
}

// --- Read operations ---

export async function getLastNChecks(
  db: D1Database,
  n: number
): Promise<CheckRow[]> {
  const result = await db
    .prepare(`SELECT * FROM checks ORDER BY timestamp DESC LIMIT ?`)
    .bind(n)
    .all<CheckRow>();
  return result.results;
}

export async function getOpenIncident(
  db: D1Database
): Promise<IncidentRow | null> {
  return db
    .prepare(`SELECT * FROM incidents WHERE ended_at IS NULL LIMIT 1`)
    .first<IncidentRow>();
}

export async function getHistory(
  db: D1Database,
  period: string
): Promise<CheckRow[]> {
  const interval = periodToInterval(period);

  if (period === "24h") {
    // Return all checks for 24h (max ~480 rows)
    const result = await db
      .prepare(
        `SELECT * FROM checks
         WHERE timestamp >= ${CUTOFF}
         ORDER BY timestamp ASC`
      )
      .bind(interval)
      .all<CheckRow>();
    return result.results;
  }

  // For 7d/30d/90d, downsample by grouping into time buckets
  const bucketMinutes = period === "7d" ? 15 : period === "30d" ? 60 : 180;

  const result = await db
    .prepare(
      `SELECT
         id,
         MIN(timestamp) as timestamp,
         CASE
           WHEN SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) > 0 THEN 'offline'
           WHEN SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) > 0 THEN 'degraded'
           ELSE 'online'
         END as status,
         ROUND(AVG(http_code)) as http_code,
         ROUND(AVG(response_time_ms)) as response_time_ms,
         NULL as error,
         NULL as reachability_status,
         ROUND(AVG(reachability_http)) as reachability_http,
         ROUND(AVG(reachability_ms)) as reachability_ms,
         NULL as reachability_error,
         NULL as portal_status,
         ROUND(AVG(portal_ms)) as portal_ms,
         NULL as portal_error,
         NULL as login_form_status,
         ROUND(AVG(login_form_ms)) as login_form_ms,
         NULL as login_form_error,
         NULL as login_e2e_status,
         ROUND(AVG(login_e2e_ms)) as login_e2e_ms,
         NULL as login_e2e_error
       FROM checks
       WHERE timestamp >= ${CUTOFF}
       GROUP BY strftime('%Y-%m-%dT%H:', timestamp) ||
         printf('%02d', (CAST(strftime('%M', timestamp) AS INTEGER) / ${bucketMinutes}) * ${bucketMinutes})
       ORDER BY timestamp ASC`
    )
    .bind(interval)
    .all<CheckRow>();
  return result.results;
}

export async function getStats(
  db: D1Database
): Promise<Record<string, { uptimePercent: number; avgResponseMs: number; incidentCount: number }>> {
  const periods = ["24h", "7d", "30d", "90d"] as const;

  // The loop this replaces awaited two queries per period -- eight round trips to the
  // D1 primary for eight rows. The SQL is not the cost here: the 90-day aggregate, the
  // heaviest of the eight, runs in about 24ms, while the endpoint took roughly 1.2s on
  // a cache miss. batch() sends all eight as one request.
  const checksStmt = db.prepare(
    `SELECT
       ROUND(100.0 * SUM(CASE WHEN status != 'offline' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 2) AS uptime_pct,
       ROUND(AVG(response_time_ms)) AS avg_ms
     FROM checks
     WHERE timestamp >= ${CUTOFF}`
  );
  const incidentsStmt = db.prepare(
    `SELECT COUNT(*) as count FROM incidents
     WHERE started_at >= ${CUTOFF}`
  );

  // Checks first, then incidents, so a period's two rows sit at i and i + periods.length.
  const rows = await db.batch<Record<string, unknown>>([
    ...periods.map(period => checksStmt.bind(periodToInterval(period))),
    ...periods.map(period => incidentsStmt.bind(periodToInterval(period))),
  ]);

  const stats: Record<string, { uptimePercent: number; avgResponseMs: number; incidentCount: number }> = {};

  periods.forEach((period, i) => {
    // Both are aggregates over a possibly empty window, so the row always exists but
    // its columns can be NULL -- the fallbacks below carry that case, as before.
    const checks = rows[i].results[0] as
      | { uptime_pct: number | null; avg_ms: number | null }
      | undefined;
    const incidents = rows[i + periods.length].results[0] as
      | { count: number | null }
      | undefined;

    stats[period] = {
      uptimePercent: checks?.uptime_pct ?? 100,
      avgResponseMs: checks?.avg_ms ?? 0,
      incidentCount: incidents?.count ?? 0,
    };
  });

  return stats;
}

export async function getLastKnownLayers(
  db: D1Database
): Promise<LastKnownLayers> {
  // The four layers are independent, so the sequence of awaits this replaces bought
  // nothing but latency: four round trips to the D1 primary to fetch four rows. The
  // comment that used to sit here justified the loop with "SQLite is local" -- it is
  // not. The worker runs at the edge and the primary sits in one region, so a round
  // trip costs tens of milliseconds against SQL that costs a fraction of one.
  //
  // Each layer needs its own predicate and column list, so this stays four statements;
  // batch() just sends them as a single request. The partial indexes in schema.sql
  // answer each one from a single row.
  const layerStmt = (selectCols: string, whereNonNull: string) =>
    db.prepare(
      `SELECT ${selectCols}, timestamp FROM checks
       WHERE ${whereNonNull} IS NOT NULL
       ORDER BY timestamp DESC LIMIT 1`
    );

  const [reachRow, portalRow, formRow, e2eRow] = await db.batch<Record<string, unknown>>([
    layerStmt(
      "reachability_status, reachability_http, reachability_ms, reachability_error",
      "reachability_status"
    ),
    layerStmt("portal_status, portal_ms, portal_error", "portal_status"),
    layerStmt("login_form_status, login_form_ms, login_form_error", "login_form_status"),
    layerStmt("login_e2e_status, login_e2e_ms, login_e2e_error", "login_e2e_status"),
  ]);

  const reachability = (reachRow.results[0] ?? null) as {
    reachability_status: LayerStatus;
    reachability_http: number | null;
    reachability_ms: number | null;
    reachability_error: string | null;
    timestamp: string;
  } | null;

  const portal = (portalRow.results[0] ?? null) as {
    portal_status: LayerStatus;
    portal_ms: number | null;
    portal_error: string | null;
    timestamp: string;
  } | null;

  const loginForm = (formRow.results[0] ?? null) as {
    login_form_status: LayerStatus;
    login_form_ms: number | null;
    login_form_error: string | null;
    timestamp: string;
  } | null;

  const loginE2e = (e2eRow.results[0] ?? null) as {
    login_e2e_status: LayerStatus;
    login_e2e_ms: number | null;
    login_e2e_error: string | null;
    timestamp: string;
  } | null;

  return {
    reachability: reachability
      ? {
          status: reachability.reachability_status,
          error: reachability.reachability_error,
          timestamp: reachability.timestamp,
          httpCode: reachability.reachability_http,
          responseTimeMs: reachability.reachability_ms,
        }
      : null,
    portal: portal
      ? {
          status: portal.portal_status,
          error: portal.portal_error,
          timestamp: portal.timestamp,
          responseTimeMs: portal.portal_ms,
        }
      : null,
    loginForm: loginForm
      ? {
          status: loginForm.login_form_status,
          error: loginForm.login_form_error,
          timestamp: loginForm.timestamp,
          responseTimeMs: loginForm.login_form_ms,
        }
      : null,
    loginE2e: loginE2e
      ? {
          status: loginE2e.login_e2e_status,
          error: loginE2e.login_e2e_error,
          timestamp: loginE2e.timestamp,
          responseTimeMs: loginE2e.login_e2e_ms,
        }
      : null,
  };
}

export async function getRecentIncidents(
  db: D1Database
): Promise<IncidentRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM incidents ORDER BY started_at DESC LIMIT 10`
    )
    .all<IncidentRow>();
  return result.results;
}

// --- Helpers ---

function periodToInterval(period: string): string {
  switch (period) {
    case "7d":
      return "-7 days";
    case "30d":
      return "-30 days";
    case "90d":
      return "-90 days";
    default:
      return "-24 hours";
  }
}

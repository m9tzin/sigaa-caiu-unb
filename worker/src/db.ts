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
  bucketExpr,
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
    // Margin over what the routes actually read: history stops at 90 days, /api/stats
    // at 90 daily buckets, the other-services chart at 30 days.
    db
      .prepare(
        `DELETE FROM check_rollup
         WHERE granularity IN ('15m','1h') AND bucket_start < ${CUTOFF}`
      )
      .bind("-100 days"),
    db
      .prepare(`DELETE FROM check_rollup WHERE granularity = '1d' AND bucket_start < ${CUTOFF}`)
      .bind("-400 days"),
    db.prepare(`DELETE FROM other_service_rollup WHERE bucket_start < ${CUTOFF}`).bind("-40 days"),
  ]);
}

/** True when the rollup has never been populated -- the deploy-time bootstrap signal. */
export async function rollupIsEmpty(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM check_rollup LIMIT 1`).first();
  return row === null;
}

/**
 * Rebuilds rollup buckets from the raw tables.
 *
 * Two callers, one body: the daily pass repairs the trailing edge ("-2 days"), and the
 * first tick after a deploy passes null to backfill the whole history. Making the
 * backfill the same code as the repair means the backfill is exercised in production
 * every day instead of being a one-shot script nobody runs twice.
 *
 * DO UPDATE *replaces* here, where the write path adds. That is what makes this safe to
 * run against a live worker: re-running it, or overlapping it with incremental upserts,
 * converges instead of double-counting.
 */
export async function recomputeRollup(
  db: D1Database,
  since: string | null
): Promise<void> {
  // A numbered parameter, not the bare "?" that CUTOFF's other callers bind at most
  // once each: bucketExpr("15m", x) references x twice (the hour part and the minute
  // part), so the same bound value has to land in both spots within one WHERE clause.
  // Defined locally rather than changing CUTOFF itself -- other callers depend on its
  // current shape.
  //
  // The cutoff is floored to each granularity's own bucket boundary (not compared
  // against a raw wall-clock instant) so a bucket is either wholly inside the window or
  // wholly outside it. A bucket split across the boundary would recompute from only its
  // post-cutoff rows, and because DO UPDATE below *replaces*, that would silently
  // overwrite a previously-correct bucket with an undercounted one -- permanently, since
  // the next day's cutoff moves past it and it never gets revisited. The comparison
  // stays "timestamp >= <floored constant>", with the raw column on the left, so
  // idx_checks_timestamp still answers it; flooring the column itself on the left would
  // turn this into a full table scan.
  const cutoffExpr = `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)`;
  const bind = (stmt: D1PreparedStatement) => (since === null ? stmt : stmt.bind(since));

  const checkCols = [
    "n", "n_offline", "n_degraded", "sum_response_ms", "n_response",
    "sum_reachability_ms", "n_reachability", "sum_portal_ms", "n_portal",
    "sum_login_form_ms", "n_login_form", "sum_login_e2e_ms", "n_login_e2e",
  ];
  const layerAggs = ["reachability", "portal", "login_form", "login_e2e"]
    .map(l => `COALESCE(SUM(${l}_ms), 0), COUNT(${l}_ms)`)
    .join(", ");

  const checkStmts = CHECK_GRANULARITIES.map(g => {
    const window = since === null ? "" : `WHERE timestamp >= ${bucketExpr(g, cutoffExpr)}`;
    return bind(
      db.prepare(
        `INSERT INTO check_rollup (granularity, bucket_start, ${checkCols.join(", ")})
         SELECT '${g}',
                ${bucketExpr(g, "timestamp")},
                COUNT(*),
                SUM(CASE WHEN status = 'offline'  THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END),
                COALESCE(SUM(response_time_ms), 0), COUNT(response_time_ms),
                ${layerAggs}
         FROM checks
         ${window}
         GROUP BY 2
         ON CONFLICT(granularity, bucket_start) DO UPDATE SET
           ${checkCols.map(c => `${c} = excluded.${c}`).join(", ")}`
      )
    );
  });

  const serviceStmts = SERVICE_GRANULARITIES.map(g => {
    const window = since === null ? "" : `WHERE timestamp >= ${bucketExpr(g, cutoffExpr)}`;
    return bind(
      db.prepare(
        `INSERT INTO other_service_rollup (granularity, bucket_start, service_id, n, sum_response_ms, n_response)
         SELECT '${g}',
                ${bucketExpr(g, "timestamp")},
                service_id,
                COUNT(*),
                COALESCE(SUM(response_time_ms), 0),
                COUNT(response_time_ms)
         FROM other_service_checks
         ${window}
         GROUP BY 2, 3
         ON CONFLICT(granularity, bucket_start, service_id) DO UPDATE SET
           n = excluded.n,
           sum_response_ms = excluded.sum_response_ms,
           n_response      = excluded.n_response`
      )
    );
  });

  await db.batch([...checkStmts, ...serviceStmts]);
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
  if (period === "24h") {
    // Raw 3-minute points, the cron's own cadence -- there is nothing to downsample.
    const result = await db
      .prepare(
        `SELECT * FROM checks
         WHERE timestamp >= ${CUTOFF}
         ORDER BY timestamp ASC`
      )
      .bind(periodToInterval(period))
      .all<CheckRow>();
    return result.results;
  }

  // 7d wants 15-minute points and 30d wants hourly ones, which the rollup stores
  // directly; 90d wants 3-hour points, built by grouping three hourly buckets. Reading
  // the coarser granularity is what keeps 90d at 2,160 rows instead of 87,879.
  const granularity = period === "7d" ? "15m" : "1h";
  const groupHours = period === "90d" ? 3 : 0;

  const bucketKey = groupHours
    ? `strftime('%Y-%m-%dT', bucket_start) || printf('%02d:00:00Z', (CAST(strftime('%H', bucket_start) AS INTEGER) / ${groupHours}) * ${groupHours})`
    : `bucket_start`;

  // A layer that never ran inside the group has n = 0. It has to come back NULL, the
  // way AVG() returned NULL over an all-NULL window: a 0 would draw a floor-hugging
  // line in LayerResponseChart instead of a gap.
  const avg = (col: string, n: string) =>
    `CASE WHEN SUM(${n}) = 0 THEN NULL ELSE ROUND(CAST(SUM(${col}) AS REAL) / SUM(${n})) END`;

  const result = await db
    .prepare(
      `SELECT
         CAST(strftime('%s', MIN(bucket_start)) AS INTEGER) as id,
         MIN(bucket_start) as timestamp,
         CASE
           WHEN SUM(n_offline)  > 0 THEN 'offline'
           WHEN SUM(n_degraded) > 0 THEN 'degraded'
           ELSE 'online'
         END as status,
         NULL as http_code,
         ${avg("sum_response_ms", "n_response")} as response_time_ms,
         NULL as error,
         NULL as reachability_status,
         NULL as reachability_http,
         ${avg("sum_reachability_ms", "n_reachability")} as reachability_ms,
         NULL as reachability_error,
         NULL as portal_status,
         ${avg("sum_portal_ms", "n_portal")} as portal_ms,
         NULL as portal_error,
         NULL as login_form_status,
         ${avg("sum_login_form_ms", "n_login_form")} as login_form_ms,
         NULL as login_form_error,
         NULL as login_e2e_status,
         ${avg("sum_login_e2e_ms", "n_login_e2e")} as login_e2e_ms,
         NULL as login_e2e_error
       FROM check_rollup
       WHERE granularity = '${granularity}'
         AND bucket_start >= ${CUTOFF}
       GROUP BY ${bucketKey}
       ORDER BY timestamp ASC`
    )
    .bind(periodToInterval(period))
    .all<CheckRow>();
  return result.results;
}

export async function getStats(
  db: D1Database
): Promise<Record<string, { uptimePercent: number; avgResponseMs: number; incidentCount: number }>> {
  const periods = ["24h", "7d", "30d", "90d"] as const;

  // This used to run eight statements that each scanned their raw window -- 60,750 rows
  // per cache miss, half the account's entire daily D1 budget on one endpoint. The
  // windows are now conditional sums over pre-aggregated buckets: one 90-row scan of the
  // daily rollup covers 7d/30d/90d, and 24 hourly rows cover 24h.
  //
  // 7d/30d/90d snap to day boundaries, so the window is "the last N whole days plus
  // today". Uptime moves in the rounding of the trailing hours only.
  // Day-floored, not "now minus N days": the daily buckets sit at T00:00:00Z, so a
  // cutoff carrying a time of day would drop the oldest bucket and make the window one
  // day narrower than it reads. Floored, "-90 days" means 90 whole days plus today.
  const dayCutoff = (days: number) =>
    `strftime('%Y-%m-%dT00:00:00Z','now','-${days} days')`;
  const windowed = (col: string, days: number) =>
    `SUM(CASE WHEN bucket_start >= ${dayCutoff(days)} THEN ${col} ELSE 0 END)`;

  const [daily, hourly, incidents] = await db.batch<Record<string, number | null>>([
    db.prepare(
      `SELECT ${([7, 30, 90] as const)
        .map(days => `${windowed("n", days)} AS n_${days}, ${windowed("n_offline", days)} AS off_${days}, ${windowed("sum_response_ms", days)} AS sum_${days}, ${windowed("n_response", days)} AS nr_${days}`)
        .join(", ")}
       FROM check_rollup
       WHERE granularity = '1d' AND bucket_start >= ${dayCutoff(90)}`
    ),
    db.prepare(
      `SELECT SUM(n) AS n, SUM(n_offline) AS off, SUM(sum_response_ms) AS sum, SUM(n_response) AS nr
       FROM check_rollup
       WHERE granularity = '1h'
         AND bucket_start >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')`
    ),
    // Incidents stay on the raw table: idx_incidents_started already answers this and
    // the measured cost was ~0. One statement instead of four, same trick.
    db.prepare(
      `SELECT
         SUM(CASE WHEN started_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours') THEN 1 ELSE 0 END) AS c_24h,
         SUM(CASE WHEN started_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')   THEN 1 ELSE 0 END) AS c_7d,
         SUM(CASE WHEN started_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')  THEN 1 ELSE 0 END) AS c_30d,
         SUM(CASE WHEN started_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 days')  THEN 1 ELSE 0 END) AS c_90d
       FROM incidents
       WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 days')`
    ),
  ]);

  const day = daily.results[0] ?? {};
  const hour = hourly.results[0] ?? {};
  const inc = incidents.results[0] ?? {};

  const stats: Record<string, { uptimePercent: number; avgResponseMs: number; incidentCount: number }> = {};

  for (const period of periods) {
    const suffix = period === "24h" ? null : period.replace("d", "");
    const n = Number((suffix ? day[`n_${suffix}`] : hour.n) ?? 0);
    const off = Number((suffix ? day[`off_${suffix}`] : hour.off) ?? 0);
    const sum = Number((suffix ? day[`sum_${suffix}`] : hour.sum) ?? 0);
    const nr = Number((suffix ? day[`nr_${suffix}`] : hour.nr) ?? 0);

    stats[period] = {
      // "degraded" counts as up, matching the status != 'offline' the raw query used.
      uptimePercent: n === 0 ? 100 : Math.round((100 * (n - off)) / n * 100) / 100,
      avgResponseMs: nr === 0 ? 0 : Math.round(sum / nr),
      incidentCount: Number(inc[`c_${period}`] ?? 0),
    };
  }

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

/**
 * Bucket maintenance for the rollup tables.
 *
 * Everything that decides *where* a row lands lives here, in SQL. The alternative --
 * computing bucket_start in JS on the write path and in SQL on the recompute path --
 * gives two formulas that must agree byte for byte forever; the day they drift,
 * ON CONFLICT silently stops matching and the upsert inserts duplicates instead of
 * summing. One formula, one place.
 */

export type Granularity = "15m" | "1h" | "1d";

export const CHECK_GRANULARITIES = ["15m", "1h", "1d"] as const satisfies readonly Granularity[];
export const SERVICE_GRANULARITIES = ["15m", "1h"] as const satisfies readonly Granularity[];

/** The nullable per-layer columns in "checks", in bind order. */
const LAYERS = ["reachability", "portal", "login_form", "login_e2e"] as const;

/**
 * Floors a timestamp expression onto its bucket, rendered in the ISO format the
 * timestamp columns store. `ts` is spliced in as SQL, so pass a bound parameter
 * ("?1") or a column name -- never user input.
 */
export function bucketExpr(granularity: Granularity, ts: string): string {
  switch (granularity) {
    case "15m":
      // strftime has no "floor to N minutes", so the minute is divided out and
      // printf pads it back to two digits.
      return `strftime('%Y-%m-%dT%H:', ${ts}) || printf('%02d:00Z', (CAST(strftime('%M', ${ts}) AS INTEGER) / 15) * 15)`;
    case "1h":
      return `strftime('%Y-%m-%dT%H:00:00Z', ${ts})`;
    case "1d":
      return `strftime('%Y-%m-%dT00:00:00Z', ${ts})`;
  }
}

/**
 * Incremental upsert for one check. Binds, in order:
 *   ?1 timestamp, ?2 status, ?3 response_time_ms,
 *   ?4 reachability_ms, ?5 portal_ms, ?6 login_form_ms, ?7 login_e2e_ms
 *
 * DO UPDATE *adds*. The recompute path in db.ts replaces instead -- the two must not
 * be swapped: adding on a recompute double-counts every bucket it touches.
 */
export function checkRollupUpsertSql(granularity: Granularity): string {
  const cols = [
    "n", "n_offline", "n_degraded", "sum_response_ms", "n_response",
    ...LAYERS.flatMap(l => [`sum_${l}_ms`, `n_${l}`]),
  ];

  // ?3 is the overall response time; the layer times start at ?4.
  const pair = (p: number) => `COALESCE(?${p}, 0), CASE WHEN ?${p} IS NULL THEN 0 ELSE 1 END`;
  const values = [
    "1",
    "CASE WHEN ?2 = 'offline'  THEN 1 ELSE 0 END",
    "CASE WHEN ?2 = 'degraded' THEN 1 ELSE 0 END",
    pair(3),
    ...LAYERS.map((_, i) => pair(4 + i)),
  ];

  const updates = [
    "n = n + 1",
    ...cols.slice(1).map(c => `${c} = ${c} + excluded.${c}`),
  ];

  return `INSERT INTO check_rollup (granularity, bucket_start, ${cols.join(", ")})
     VALUES ('${granularity}', ${bucketExpr(granularity, "?1")}, ${values.join(", ")})
     ON CONFLICT(granularity, bucket_start) DO UPDATE SET ${updates.join(", ")}`;
}

/**
 * Incremental upsert for one auxiliary-service check. Binds, in order:
 *   ?1 timestamp, ?2 service_id, ?3 response_time_ms
 */
export function serviceRollupUpsertSql(granularity: Granularity): string {
  return `INSERT INTO other_service_rollup (granularity, bucket_start, service_id, n, sum_response_ms, n_response)
     VALUES ('${granularity}', ${bucketExpr(granularity, "?1")}, ?2,
             1, COALESCE(?3, 0), CASE WHEN ?3 IS NULL THEN 0 ELSE 1 END)
     ON CONFLICT(granularity, bucket_start, service_id) DO UPDATE SET
       n = n + 1,
       sum_response_ms = sum_response_ms + excluded.sum_response_ms,
       n_response      = n_response      + excluded.n_response`;
}

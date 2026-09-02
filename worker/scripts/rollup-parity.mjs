#!/usr/bin/env node
// Proves the rollup answers the same questions the raw tables did.
//
// Why this and not unit tests: the risk here is SQL semantics against the real data
// distribution -- layers NULL for long stretches, cron gaps, the sample burst during an
// incident, bucket edges. Synthetic fixtures model exactly the cases we already thought
// of, which is the wrong coverage. The raw rows are still there during the transition,
// so both queries can run side by side against production and be required to agree.
//
//   npm run rollup:parity          # the remote database
//   npm run rollup:parity:local    # the local one wrangler dev uses (for dev-time checks
//                                  # and for exercising this script before the rollup
//                                  # tables exist remotely)
//
// Exit 0 agree, 1 diverge, 2 could not query (same contract as db-verify.mjs).
//
// Two behaviour changes between the raw path and the rollup path are intentional and
// are deliberately NOT covered here as old-vs-new comparisons:
//   - /api/history 90d now produces true 3-hour points. The old raw query's group key
//     was printf('%02d', (minute / 180) * 180), and an integer minute never exceeds 59,
//     so that term was always 0 and 90d silently grouped hourly instead. Any old-vs-new
//     comparison of 90d point counts would differ by design, 3:1.
//   - The other-services average now divides by the count of samples that actually
//     produced a timing (n_response), where the old JS pivot summed NULLs as 0 but still
//     counted them, depressing the average. On [100, 100, NULL] the old gave 67 and the
//     new gives 100. See pivotOtherServiceRows in src/api.ts.
// A case that compared either of these old-vs-new would report spurious divergence.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");

/**
 * wrangler.jsonc is JSON with comments in principle -- a regex extracts the one field
 * this script needs without caring about JSONC syntax (inline comments, block
 * comments, trailing commas) that would make a whole-file JSON.parse throw. Same
 * idiom as databaseName() in db-verify.mjs, except this exits 2 instead of throwing:
 * an uncaught exception here would exit the process with code 1, which this script's
 * own contract reserves for "diverged" -- a config file could not be parsed is
 * "could not query", not a divergence.
 */
function databaseName() {
  const raw = readFileSync(join(workerDir, "wrangler.jsonc"), "utf8");
  const match = /"database_name"\s*:\s*"([^"]+)"/.exec(raw);
  if (!match) {
    console.error("database_name nao encontrado em wrangler.jsonc");
    process.exit(2);
  }
  return match[1];
}

const dbName = databaseName();

function query(sql) {
  try {
    const out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", dbName, local ? "--local" : "--remote", "--json", "--command", sql],
      { cwd: workerDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    return { rows: parsed[0].results, rowsRead: parsed[0].meta.rows_read };
  } catch (err) {
    console.error(`nao consegui consultar o D1: ${err.message.split("\n")[0]}`);
    process.exit(2);
  }
}

const ISO = "strftime('%Y-%m-%dT%H:%M:%SZ','now',";

// Each case: the old query, the new one, and how much they may differ.
const CASES = [
  {
    // getStats compares '1d' bucket_start against a day-floored cutoff, not a
    // wall-clock one (see the CUTOFF comment in src/db.ts) -- so the raw side has to
    // use the same day-floored form, or this reports spurious divergence at the
    // window edge every time "now" is not exactly midnight.
    name: "uptime 90d",
    old: `SELECT ROUND(100.0 * SUM(CASE WHEN status != 'offline' THEN 1 ELSE 0 END) / MAX(COUNT(*),1), 2) AS v
          FROM checks WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z','now','-90 days')`,
    new: `SELECT ROUND(100.0 * (SUM(n) - SUM(n_offline)) / MAX(SUM(n),1), 2) AS v
          FROM check_rollup WHERE granularity='1d'
            AND bucket_start >= strftime('%Y-%m-%dT00:00:00Z','now','-90 days')`,
    tolerance: 0.05, // day-edge snapping, per the spec
  },
  {
    name: "avg response 7d",
    old: `SELECT ROUND(AVG(response_time_ms)) AS v
          FROM checks WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z','now','-7 days')`,
    new: `SELECT ROUND(CAST(SUM(sum_response_ms) AS REAL) / MAX(SUM(n_response),1)) AS v
          FROM check_rollup WHERE granularity='1d'
            AND bucket_start >= strftime('%Y-%m-%dT00:00:00Z','now','-7 days')`,
    tolerance: 5,
  },
  {
    // Composition: an hourly bucket rebuilt from four 15-minute ones must equal the raw
    // average. This is the proof that sum/count was right and storing averages would
    // have been wrong.
    name: "composicao 15m -> 1h",
    old: `SELECT COUNT(*) AS v FROM (
            SELECT strftime('%Y-%m-%dT%H:00:00Z', bucket_start) AS h,
                   SUM(sum_response_ms) AS s, SUM(n_response) AS n
            FROM check_rollup WHERE granularity='15m'
              AND bucket_start >= ${ISO}'-7 days')
            GROUP BY 1
          ) a JOIN check_rollup b
            ON b.granularity='1h' AND b.bucket_start = a.h
          WHERE a.s != b.sum_response_ms OR a.n != b.n_response`,
    new: `SELECT 0 AS v`,
    tolerance: 0, // zero mismatched hours
  },
  {
    // A layer that never ran must stay NULL, not become 0. This exercises the actual
    // CASE WHEN SUM(n_x) = 0 THEN NULL projection getHistory ships (src/db.ts), not
    // just an internal n/sum invariant over check_rollup's own columns: n_portal = 0
    // implies sum_portal_ms = 0 by construction of every writer (COALESCE(?, 0) /
    // COUNT(?) always agree), so a check confined to the rollup table alone can never
    // fail regardless of whether the projection is right. This one joins the raw-side
    // AVG (NULL when a bucket has no portal readings) against the exact rollup-side
    // expression getHistory uses, and looks for the one way the projection can
    // regress: yielding 0 where the raw side has nothing to average at all.
    name: "camada ausente vira NULL (projecao de getHistory)",
    old: `SELECT COUNT(*) AS v FROM (
            SELECT strftime('%Y-%m-%dT%H:00:00Z', c.timestamp) AS h, AVG(c.portal_ms) AS raw_avg
            FROM checks c
            WHERE c.timestamp >= ${ISO}'-30 days')
            GROUP BY h
          ) raw
          JOIN (
            SELECT bucket_start AS h,
                   CASE WHEN SUM(n_portal) = 0 THEN NULL
                        ELSE ROUND(CAST(SUM(sum_portal_ms) AS REAL) / SUM(n_portal)) END AS roll_val
            FROM check_rollup
            WHERE granularity = '1h' AND bucket_start >= ${ISO}'-30 days')
            GROUP BY bucket_start
          ) roll ON roll.h = raw.h
          WHERE raw.raw_avg IS NULL AND roll.roll_val = 0`,
    new: `SELECT 0 AS v`,
    tolerance: 0, // zero buckets where the gap became a floor-hugging 0
  },
  {
    // Recompute idempotency (spec's mandatory case 3): the invariant a double-counting
    // recompute breaks, which is exactly what the write path's ADD vs the recompute
    // path's REPLACE (see src/rollup.ts) exists to prevent. Re-running recomputeRollup
    // twice and diffing the table would prove this directly but needs a write this
    // read-only script deliberately avoids (it runs against production too). This is
    // the read-only proxy instead: a day's total can be reached three independent ways
    // -- summed from '15m' buckets, read straight off the '1d' bucket, or counted from
    // raw checks -- and a double-count desyncs exactly one of those three from the
    // other two. Restricted to full UTC days (excludes today) so a cron write landing
    // between this query and the next can't make an in-progress day look wrong.
    name: "consistencia entre granularidades (15m/1d/cru)",
    old: `SELECT COUNT(*) AS v FROM (
            SELECT date(bucket_start) AS d, SUM(n) AS s
            FROM check_rollup
            WHERE granularity = '15m'
              AND bucket_start >= ${ISO}'-7 days')
              AND bucket_start < strftime('%Y-%m-%dT00:00:00Z','now')
            GROUP BY d
          ) fifteen
          JOIN (
            SELECT date(bucket_start) AS d, n FROM check_rollup WHERE granularity = '1d'
          ) daily ON daily.d = fifteen.d
          JOIN (
            SELECT date(timestamp) AS d, COUNT(*) AS c FROM checks GROUP BY d
          ) raw ON raw.d = fifteen.d
          WHERE fifteen.s != daily.n OR fifteen.s != raw.c`,
    new: `SELECT 0 AS v`,
    tolerance: 0, // zero days where the three counts disagree
  },
  {
    // A count of timed samples cannot exceed the count of samples. Cheap invariant
    // over the rollup alone (no raw-side query needed) -- the shape a double-counting
    // upsert would produce, which is exactly the failure mode the add-vs-replace
    // distinction between the write path and the recompute path (see src/rollup.ts)
    // exists to prevent.
    name: "invariante: n_response <= n (other_service_rollup)",
    old: `SELECT COUNT(*) AS v FROM other_service_rollup WHERE n_response > n`,
    new: `SELECT 0 AS v`,
    tolerance: 0,
  },
  {
    // Same invariant, check_rollup's status counters: offline + degraded rows cannot
    // outnumber the total rows in the bucket.
    name: "invariante: n_offline+n_degraded <= n (check_rollup)",
    old: `SELECT COUNT(*) AS v FROM check_rollup WHERE n_offline + n_degraded > n`,
    new: `SELECT 0 AS v`,
    tolerance: 0,
  },
  ...seriesVsSeries(),
];

/**
 * Series-vs-series comparison of /api/history at zero tolerance, for 7d and 30d (the
 * spec's mandatory third comparison for that endpoint). 90d is deliberately excluded --
 * see the header comment: it now groups into true 3-hour buckets where the old raw
 * query silently grouped hourly, so an old-vs-new comparison of 90d would differ by
 * design, 3:1, and reporting that as divergence would be wrong.
 *
 * This reconstructs both getHistory queries directly in SQL rather than driving the
 * live route: no worker needs to be running for `npm run rollup:parity` to exercise it,
 * and the whole point of this script is to compare the two data paths without a network
 * hop between them. It only compares the fields both queries derive from real data
 * (status and the five *_ms averages) -- http_code, error, id and timestamp are
 * excluded because they differ by design between the two paths (see the "Mudanças
 * visíveis" section of the spec), not because either side is wrong.
 */
function seriesVsSeries() {
  // Same CASE the old raw-side query used before the rollup existed (see the pre-branch
  // src/db.ts) and the same one getHistory (src/db.ts) uses now -- written out twice on
  // purpose so a change to either one shows up as a real divergence instead of the test
  // quietly comparing a query against itself.
  const statusCase = (offlineExpr, degradedExpr) =>
    `CASE WHEN ${offlineExpr} > 0 THEN 'offline'
          WHEN ${degradedExpr} > 0 THEN 'degraded'
          ELSE 'online' END`;

  const rawAvg = col => `ROUND(AVG(${col}))`;
  const rollAvg = (sumCol, nCol) =>
    `CASE WHEN SUM(${nCol}) = 0 THEN NULL ELSE ROUND(CAST(SUM(${sumCol}) AS REAL) / SUM(${nCol})) END`;

  const nullSafeNe = (a, b) => `IFNULL(${a}, -1) != IFNULL(${b}, -1)`;

  return [
    { period: "7d", granularity: "15m", bucketExpr:
        `strftime('%Y-%m-%dT%H:', timestamp) || printf('%02d:00Z', (CAST(strftime('%M', timestamp) AS INTEGER) / 15) * 15)` },
    { period: "30d", granularity: "1h", bucketExpr: `strftime('%Y-%m-%dT%H:00:00Z', timestamp)` },
  ].map(({ period, granularity, bucketExpr }) => ({
    name: `serie /api/history ${period} (cru x rollup)`,
    old: `SELECT COUNT(*) AS v FROM (
            SELECT
              ${bucketExpr} AS bk,
              ${statusCase(
                "SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END)",
                "SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END)"
              )} AS status,
              ${rawAvg("response_time_ms")} AS response_time_ms,
              ${rawAvg("reachability_ms")} AS reachability_ms,
              ${rawAvg("portal_ms")} AS portal_ms,
              ${rawAvg("login_form_ms")} AS login_form_ms,
              ${rawAvg("login_e2e_ms")} AS login_e2e_ms
            FROM checks
            WHERE timestamp >= ${ISO}'-${period === "7d" ? "7" : "30"} days')
            GROUP BY bk
          ) raw
          JOIN (
            SELECT
              bucket_start AS bk,
              ${statusCase("SUM(n_offline)", "SUM(n_degraded)")} AS status,
              ${rollAvg("sum_response_ms", "n_response")} AS response_time_ms,
              ${rollAvg("sum_reachability_ms", "n_reachability")} AS reachability_ms,
              ${rollAvg("sum_portal_ms", "n_portal")} AS portal_ms,
              ${rollAvg("sum_login_form_ms", "n_login_form")} AS login_form_ms,
              ${rollAvg("sum_login_e2e_ms", "n_login_e2e")} AS login_e2e_ms
            FROM check_rollup
            WHERE granularity = '${granularity}'
              AND bucket_start >= ${ISO}'-${period === "7d" ? "7" : "30"} days')
            GROUP BY bucket_start
          ) roll ON roll.bk = raw.bk
          WHERE roll.status != raw.status
             OR ${nullSafeNe("roll.response_time_ms", "raw.response_time_ms")}
             OR ${nullSafeNe("roll.reachability_ms", "raw.reachability_ms")}
             OR ${nullSafeNe("roll.portal_ms", "raw.portal_ms")}
             OR ${nullSafeNe("roll.login_form_ms", "raw.login_form_ms")}
             OR ${nullSafeNe("roll.login_e2e_ms", "raw.login_e2e_ms")}`,
    new: `SELECT 0 AS v`,
    tolerance: 0, // zero tolerance, per the spec
  }));
}

// An aggregate query over a window with no matching rows (SUM/AVG with nothing to sum)
// comes back as SQL NULL, which wrangler's --json output renders as the string "null"
// against the local D1 (observed against --local; not just JSON's own null) rather than
// omitting the field. Treat both the same as 0 -- an empty window agreeing with an empty
// window is exactly what "no divergence" should mean here.
const toNum = v => (v === null || v === undefined || v === "null" ? 0 : Number(v));

let failed = false;
console.log(`\nparidade rollup x cru (${dbName}, ${local ? "local" : "remoto"})\n`);

for (const c of CASES) {
  const a = query(c.old);
  const b = query(c.new);
  const va = toNum(a.rows[0]?.v);
  const vb = toNum(b.rows[0]?.v);
  const delta = Math.abs(va - vb);
  const ok = delta <= c.tolerance;
  if (!ok) failed = true;
  console.log(
    `  ${ok ? "ok  " : "FALHA"} ${c.name.padEnd(50)} cru=${va}  rollup=${vb}  delta=${delta.toFixed(2)} (tol ${c.tolerance})`
  );
  console.log(`       linhas lidas: cru=${a.rowsRead}  rollup=${b.rowsRead}`);
}

console.log(
  failed
    ? "\ndivergencia acima da tolerancia; NAO atualize ROWS_PER_MISS ate resolver\n"
    : "\ntudo em dia -- use as linhas lidas acima para atualizar ROWS_PER_MISS em cache-stats.mjs\n"
);
process.exit(failed ? 1 : 0);

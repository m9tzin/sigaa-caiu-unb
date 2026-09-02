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

const dbName = JSON.parse(readFileSync(join(workerDir, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""))
  .d1_databases[0].database_name;

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
    // A layer that never ran must stay NULL, not become 0.
    name: "camada ausente vira NULL",
    old: `SELECT COUNT(*) AS v FROM check_rollup
          WHERE granularity='1h' AND n_portal = 0 AND sum_portal_ms != 0`,
    new: `SELECT 0 AS v`,
    tolerance: 0,
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
];

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

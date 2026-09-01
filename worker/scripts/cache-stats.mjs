#!/usr/bin/env node
// Live cache hit rate from real production traffic.
//
// Streams `wrangler tail`, aggregates the structured lines emitted by cache.ts, and
// prints hit rate plus the D1 rows those hits avoided, broken down by route.
//
//   npm run cache:stats
//
// Ctrl-C prints the final table. Needs traffic to be flowing: on a quiet site, open
// the page in a browser and leave it for a few minutes.

import { spawn } from "node:child_process";

// Rows scanned per cache miss, from the D1 audit. These are derived from the cron
// cadence (480 checks/day) and the retention in schema.sql, not measured -- they turn
// the hit counts into an order-of-magnitude "rows avoided", nothing more precise.
const ROWS_PER_MISS = {
  "v1/api/status": 15, // after the partial layer indexes
  "v1/api/other-services": 4, // after the batched per-service lookup
  "v1/api/stats": 61_440,
  "v1/api/incidents": 10,
  "v1/api/history/24h": 480,
  "v1/api/history/7d": 3_360,
  "v1/api/history/30d": 14_400,
  "v1/api/history/90d": 43_200,
  "v1/api/other-services/history/24h": 1_920,
  "v1/api/other-services/history/7d": 13_440,
  "v1/api/other-services/history/30d": 57_600,
  "v1/": 0,
};

const stats = new Map(); // route -> { "HIT-isolate": n, "HIT-edge": n, MISS: n }
let started = Date.now();

function record(route, state) {
  if (!stats.has(route)) stats.set(route, { "HIT-isolate": 0, "HIT-edge": 0, MISS: 0 });
  const row = stats.get(route);
  if (state in row) row[state] += 1;
}

/** Pull our structured lines out of whatever shape wrangler hands back. */
function harvest(chunk) {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    for (const log of event.logs ?? []) {
      for (const part of log.message ?? []) {
        if (typeof part !== "string" || !part.includes('"cache"')) continue;
        try {
          const parsed = JSON.parse(part);
          if (parsed.msg === "cache") record(parsed.route, parsed.state);
        } catch {
          // not ours
        }
      }
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

function table() {
  const routes = [...stats.keys()].sort();
  if (routes.length === 0) {
    console.log("\n(sem trafego ainda -- abra o site e deixe a aba aberta)\n");
    return;
  }

  const minutes = (Date.now() - started) / 60_000;
  console.log(`\n── cache · ${minutes.toFixed(1)} min de trafego ──\n`);
  console.log(
    pad("rota", 38) + num("req", 6) + num("isolate", 9) + num("edge", 7) +
    num("miss", 7) + num("hit%", 7) + num("rows evitadas", 15)
  );
  console.log("─".repeat(89));

  let totals = { req: 0, hit: 0, avoided: 0, spent: 0 };

  for (const route of routes) {
    const r = stats.get(route);
    const req = r["HIT-isolate"] + r["HIT-edge"] + r.MISS;
    const hit = r["HIT-isolate"] + r["HIT-edge"];
    const perMiss = ROWS_PER_MISS[route] ?? 0;
    const avoided = hit * perMiss;

    totals.req += req;
    totals.hit += hit;
    totals.avoided += avoided;
    totals.spent += r.MISS * perMiss;

    console.log(
      pad(route, 38) + num(req, 6) + num(r["HIT-isolate"], 9) + num(r["HIT-edge"], 7) +
      num(r.MISS, 7) + num(req ? ((100 * hit) / req).toFixed(0) + "%" : "-", 7) +
      num(avoided.toLocaleString("pt-BR"), 15)
    );
  }

  console.log("─".repeat(89));
  const rate = totals.req ? ((100 * totals.hit) / totals.req).toFixed(1) : "0";
  console.log(
    pad("TOTAL", 38) + num(totals.req, 6) + num("", 9) + num("", 7) + num("", 7) +
    num(rate + "%", 7) + num(totals.avoided.toLocaleString("pt-BR"), 15)
  );
  console.log(`\nrows lidas de fato: ${totals.spent.toLocaleString("pt-BR")}`);

  // The edge tier is a no-op on *.workers.dev; say so rather than let a 0 look like
  // a hit-rate problem.
  const edgeHits = routes.reduce((a, r) => a + stats.get(r)["HIT-edge"], 0);
  if (totals.req > 20 && edgeHits === 0) {
    console.log(
      "\naviso: zero HIT-edge. Esperado em *.workers.dev, onde a Cloudflare nao\n" +
      "cacheia. Num dominio proprio esse numero deve subir."
    );
  }
  console.log();
}

// --stdin replays a saved tail dump instead of opening a live one:
//   npx wrangler tail --format json > tail.log   # later
//   node scripts/cache-stats.mjs --stdin < tail.log
if (process.argv.includes("--stdin")) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", harvest);
  process.stdin.on("end", () => {
    table();
    process.exit(0);
  });
} else {
  const tail = spawn("npx", ["wrangler", "tail", "--format", "json"], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  tail.stdout.setEncoding("utf8");
  tail.stdout.on("data", harvest);
  tail.on("exit", (code) => {
    table();
    process.exit(code ?? 0);
  });

  const timer = setInterval(table, 30_000);

  process.on("SIGINT", () => {
    clearInterval(timer);
    tail.kill("SIGINT");
  });

  console.log("lendo trafego via `wrangler tail`... Ctrl-C para o resumo final.");
}

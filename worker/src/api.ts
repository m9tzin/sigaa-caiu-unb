import type { Env, RawOtherServiceRow } from "./types";
import {
  getLastNChecks,
  getOpenIncident,
  getHistory,
  getStats,
  getRecentIncidents,
  getLastKnownLayers,
  getLatestOtherServiceChecks,
  getOtherServiceHistoryRaw,
} from "./db";
import { OTHER_SERVICES } from "./other-services";

export async function handleApiRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/status") {
    return handleStatus(env);
  }

  if (path === "/api/history") {
    const period = url.searchParams.get("period") || "24h";
    if (!["24h", "7d", "30d", "90d"].includes(period)) {
      return json({ error: "Invalid period. Use: 24h, 7d, 30d, 90d" }, 400);
    }
    return handleHistory(env, period);
  }

  if (path === "/api/stats") {
    return handleStats(env);
  }

  if (path === "/api/incidents") {
    return handleIncidents(env);
  }

  if (path === "/api/other-services") {
    return handleOtherServices(env);
  }

  if (path === "/api/other-services/history") {
    const period = url.searchParams.get("period") || "24h";
    if (period !== "24h" && period !== "7d" && period !== "30d") {
      return json({ error: "Invalid period. Use: 24h, 7d, 30d" }, 400);
    }
    return handleOtherServicesHistory(env, period);
  }

  if (path === "/") {
    return new Response(DOCS_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return json({ error: "Not found" }, 404);
}

async function handleStatus(env: Env): Promise<Response> {
  const lastChecks = await getLastNChecks(env.DB, 5);
  const openIncident = await getOpenIncident(env.DB);

  if (lastChecks.length === 0) {
    return json({
      status: "unknown",
      confirmed: false,
      lastCheck: null,
      consecutiveFailures: 0,
      currentIncident: openIncident,
    });
  }

  let consecutiveFailures = 0;
  for (const check of lastChecks) {
    if (check.status === "offline") {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  const latestStatus = lastChecks[0].status;
  const confirmed =
    latestStatus !== "offline" || consecutiveFailures >= 2;

  const layers = await getLastKnownLayers(env.DB);

  return json({
    status: latestStatus,
    confirmed,
    lastCheck: {
      timestamp: lastChecks[0].timestamp,
      status: lastChecks[0].status,
      httpCode: lastChecks[0].http_code,
      responseTimeMs: lastChecks[0].response_time_ms,
    },
    consecutiveFailures,
    currentIncident: openIncident,
    layers,
  });
}

async function handleHistory(env: Env, period: string): Promise<Response> {
  const checks = await getHistory(env.DB, period);
  return json({ period, checks });
}

async function handleStats(env: Env): Promise<Response> {
  const stats = await getStats(env.DB);
  return json({ periods: stats });
}

async function handleIncidents(env: Env): Promise<Response> {
  const incidents = await getRecentIncidents(env.DB);
  return json({ incidents });
}

async function handleOtherServicesHistory(env: Env, period: "24h" | "7d" | "30d"): Promise<Response> {
  const rows = await getOtherServiceHistoryRaw(env.DB, period);
  const bucketMinutes = period === "30d" ? 60 : period === "7d" ? 15 : 3;
  const checks = pivotOtherServiceRows(rows, bucketMinutes);
  return json({ period, checks });
}

function bucketTs(ts: string, bucketMinutes: number): string {
  const d = new Date(ts);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / bucketMinutes) * bucketMinutes, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pivotOtherServiceRows(
  rows: RawOtherServiceRow[],
  bucketMinutes: number
): { timestamp: string; matriculaweb_ms: number | null; bce_ms: number | null }[] {
  const buckets = new Map<string, Record<string, { sum: number; count: number }>>();

  for (const row of rows) {
    const ts = bucketTs(row.timestamp, bucketMinutes);
    if (!buckets.has(ts)) buckets.set(ts, {});
    const b = buckets.get(ts)!;
    const key = `${row.service_id}_ms`;
    if (!b[key]) b[key] = { sum: 0, count: 0 };
    b[key].sum += row.response_time_ms;
    b[key].count++;
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ts, b]) => ({
      timestamp: ts,
      matriculaweb_ms: b.matriculaweb_ms ? Math.round(b.matriculaweb_ms.sum / b.matriculaweb_ms.count) : null,
      bce_ms: b.bce_ms ? Math.round(b.bce_ms.sum / b.bce_ms.count) : null,
    }));
}

async function handleOtherServices(env: Env): Promise<Response> {
  const rows = await getLatestOtherServiceChecks(env.DB);
  const services = OTHER_SERVICES.map(def => {
    const row = rows.find(r => r.service_id === def.id);
    return {
      id: def.id,
      name: def.name,
      url: def.url,
      status: row?.status ?? "unknown",
      httpCode: row?.http_code ?? null,
      responseTimeMs: row?.response_time_ms ?? null,
      timestamp: row?.timestamp ?? null,
      error: row?.error ?? null,
    };
  });
  return json({ services });
}

const DOCS_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SIGAA Caiu? — API</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #171717; line-height: 1.6; padding: 2rem; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 2rem; margin-bottom: 0.25rem; }
  .sub { color: #737373; margin-bottom: 2rem; }
  .sub a { color: #737373; }
  h2 { font-size: 1.1rem; margin-top: 2rem; margin-bottom: 0.5rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; }
  h2:first-of-type { border-top: none; padding-top: 0; }
  code { background: #f0f0f0; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.9rem; }
  pre { background: #1a1a1a; color: #e5e5e5; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 0.75rem 0; font-size: 0.85rem; line-height: 1.5; }
  pre code { background: none; padding: 0; }
  .endpoint { margin-bottom: 1.5rem; }
  .method { color: #22c55e; font-weight: bold; }
  p { margin: 0.5rem 0; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid #e5e5e5; }
  th { font-weight: 600; color: #525252; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; color: #a3a3a3; font-size: 0.8rem; }
  footer a { color: #a3a3a3; }
</style>
</head>
<body>
<h1>SIGAA Caiu? API</h1>
<p class="sub">API publica do monitor de status do SIGAA da UnB. Sem autenticacao.<br><a href="https://unb.sigaacaiu.com">unb.sigaacaiu.com</a> · <a href="https://github.com/m9tzin/sigaa-caiu-unb">GitHub</a></p>

<h2><span class="method">GET</span> <code>/api/status</code></h2>
<div class="endpoint">
<p>Status atual do SIGAA com detalhamento por camada de verificacao.</p>
<pre><code>{
  "status": "online",
  "confirmed": true,
  "lastCheck": {
    "timestamp": "2026-03-10T12:00:00Z",
    "status": "online",
    "httpCode": 200,
    "responseTimeMs": 724
  },
  "consecutiveFailures": 0,
  "currentIncident": null,
  "layers": {
    "reachability": { "status": "online", "error": null, "timestamp": "...", "httpCode": 200, "responseTimeMs": 479 },
    "portal":       { "status": "online", "error": null, "timestamp": "..." },
    "loginForm":    { "status": "online", "error": null, "timestamp": "..." },
    "loginE2e":     { "status": "skipped", "error": null, "timestamp": "..." }
  }
}</code></pre>
<table>
<tr><th>Campo</th><th>Descricao</th></tr>
<tr><td><code>status</code></td><td><code>online</code>, <code>degraded</code> ou <code>offline</code> (derivado das camadas)</td></tr>
<tr><td><code>confirmed</code></td><td><code>false</code> se houve apenas 1 falha (possivel instabilidade de rede)</td></tr>
<tr><td><code>consecutiveFailures</code></td><td>Numero de falhas consecutivas</td></tr>
<tr><td><code>currentIncident</code></td><td>Incidente em andamento, se houver</td></tr>
<tr><td><code>layers</code></td><td>Status individual de cada camada de verificacao (ver abaixo)</td></tr>
</table>
<p style="margin-top:1rem"><strong>Camadas de verificacao:</strong></p>
<table>
<tr><th>Camada</th><th>O que verifica</th></tr>
<tr><td><code>reachability</code></td><td>Servidor acessivel (GET verTelaLogin.do, espera 200/302)</td></tr>
<tr><td><code>portal</code></td><td>Pagina de login carrega com conteudo esperado</td></tr>
<tr><td><code>loginForm</code></td><td>Formulario de login renderiza com campos user.login e user.senha</td></tr>
<tr><td><code>loginE2e</code></td><td>Login completo funciona (skipped por padrao)</td></tr>
</table>
</div>

<h2><span class="method">GET</span> <code>/api/history?period=24h|7d|30d</code></h2>
<div class="endpoint">
<p>Historico de checks. Dados agregados para 7d e 30d.</p>
<pre><code>{
  "period": "24h",
  "checks": [
    {
      "id": 1,
      "timestamp": "2026-03-10T12:00:00Z",
      "status": "online",
      "http_code": 200,
      "response_time_ms": 724,
      "error": null
    }
  ]
}</code></pre>
</div>

<h2><span class="method">GET</span> <code>/api/stats</code></h2>
<div class="endpoint">
<p>Uptime e tempo medio de resposta por periodo.</p>
<pre><code>{
  "periods": {
    "24h": { "uptimePercent": 99.5, "avgResponseMs": 800, "incidentCount": 1 },
    "7d":  { "uptimePercent": 98.2, "avgResponseMs": 900, "incidentCount": 3 },
    "30d": { "uptimePercent": 97.8, "avgResponseMs": 850, "incidentCount": 5 }
  }
}</code></pre>
</div>

<h2><span class="method">GET</span> <code>/api/incidents</code></h2>
<div class="endpoint">
<p>Ultimos 10 incidentes.</p>
<pre><code>{
  "incidents": [
    {
      "id": 1,
      "started_at": "2026-03-09T14:00:00Z",
      "ended_at": "2026-03-09T14:12:00Z",
      "duration_s": 720
    }
  ]
}</code></pre>
</div>

<footer>
  Verifica o SIGAA da UnB a cada 3 minutos com 3 camadas de verificacao · <a href="https://github.com/m9tzin/sigaa-caiu-unb">GitHub</a>
</footer>
</body>
</html>`;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

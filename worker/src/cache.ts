// Read-through cache for the public GET API.
//
// Deliberately sits at the HTTP layer rather than inside db.ts: the cron path calls
// db.ts directly and must always see live data (it decides when to open and close
// incidents), so keeping the cache here makes that separation structural instead of
// something every future caller has to remember.
//
// Three tiers:
//
//   1. isolate memory  — answers first and skips even the async cache lookup. Lives as
//                        long as the isolate does, which under steady traffic is
//                        minutes.
//   2. caches.default  — the edge cache, shared by every isolate in a colo. Verified
//                        serving X-Cache: HIT-edge on the *.workers.dev hostname. It
//                        is per colo and evictable under memory pressure, so it lowers
//                        the average cost of a request rather than capping it.
//   3. Cache-Control   — browser cache. Costs the worker nothing at all: a hit here
//                        never reaches Cloudflare.

const CACHE_VERSION = "v1";

/** Edge/isolate TTL and browser TTL, in seconds. */
type Ttl = { edge: number; browser: number };

/**
 * Browser TTL is kept below the edge TTL so worst-case staleness (browser entry
 * fetched just before the edge entry expires) stays bounded and predictable.
 */
const ROUTES: Record<string, Ttl> = {
  "/": { edge: 86_400, browser: 3_600 },       // static docs string in the bundle
  "/api/status": { edge: 60, browser: 30 },    // cron writes every 180s
  "/api/other-services": { edge: 60, browser: 30 },
  "/api/incidents": { edge: 300, browser: 120 },
  "/api/stats": { edge: 600, browser: 300 },   // uptime over 24h+ barely moves
};

/** History is bucketed server-side; refreshing faster than a bucket buys nothing. */
const HISTORY_TTL: Record<string, Ttl> = {
  "24h": { edge: 180, browser: 90 },     // 3-minute raw points
  "7d": { edge: 900, browser: 300 },     // 15-minute buckets
  "30d": { edge: 1_800, browser: 600 },  // 60-minute buckets
  "90d": { edge: 3_600, browser: 900 },  // 180-minute buckets
};

const HISTORY_PATHS = new Set(["/api/history", "/api/other-services/history"]);

type Route = { key: string; ttl: Ttl };

/**
 * Whitelist: an unlisted path is never cached, so a new route starts uncached and
 * caching it is a deliberate act. Query params are dropped unless they are a period
 * this route actually understands -- otherwise /api/status?x=<random> would mint an
 * unbounded number of cache keys, each one a fresh D1 query.
 */
export function routeFor(url: URL): Route | null {
  const path = url.pathname;

  if (HISTORY_PATHS.has(path)) {
    const period = url.searchParams.get("period") ?? "24h";
    const ttl = HISTORY_TTL[period];
    if (!ttl) return null; // handler rejects it with a 400; nothing to cache
    return { key: `${CACHE_VERSION}${path}/${period}`, ttl };
  }

  const ttl = ROUTES[path];
  return ttl ? { key: `${CACHE_VERSION}${path}`, ttl } : null;
}

// --- Tier 1: isolate-local memory ---

type Entry = { body: string; contentType: string; expiresAt: number };

const memo = new Map<string, Entry>();
// ~10 distinct keys exist in practice; the cap only guards against a leak. The 90d
// history payload is the largest entry, at a few hundred KB.
const MEMO_MAX = 16;

function remember(key: string, body: string, contentType: string, ttlS: number): void {
  if (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, { body, contentType, expiresAt: Date.now() + ttlS * 1_000 });
}

// --- Response assembly ---

/**
 * One structured line per request, picked up by Workers Logs (observability.logs is
 * already enabled in wrangler.jsonc). This is what turns the estimated hit rates in
 * the cache audit into measured ones -- notably per colo, which is the number that
 * decides whether the rollup work in phase 5 is still needed.
 *
 * Aggregate it live with: npm run cache:stats
 */
function logCache(route: string, state: string, ttl: Ttl): void {
  console.log(JSON.stringify({ msg: "cache", route, state, ttl: ttl.edge }));
}

function build(body: string, contentType: string, ttl: Ttl, marker: string | null): Response {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control":
      `public, max-age=${ttl.browser}, s-maxage=${ttl.edge}, stale-while-revalidate=${ttl.edge}`,
  });
  // Diagnostic only. Lets a curl confirm which tier answered, which matters most
  // while the edge tier is dormant on workers.dev.
  if (marker) headers.set("X-Cache", marker);
  return new Response(body, { headers });
}

export async function withEdgeCache(
  request: Request,
  ctx: ExecutionContext,
  handler: () => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  const route = routeFor(url);
  if (!route) return handler();

  const { key, ttl } = route;

  const local = memo.get(key);
  if (local && local.expiresAt > Date.now()) {
    logCache(key, "HIT-isolate", ttl);
    return build(local.body, local.contentType, ttl, "HIT-isolate");
  }

  const cache = caches.default;
  const cacheRequest = new Request(`https://${url.host}/__cache/${key}`);

  const stored = await cache.match(cacheRequest);
  if (stored) {
    const body = await stored.text();
    const contentType = stored.headers.get("Content-Type") ?? "application/json";
    remember(key, body, contentType, ttl.edge);
    logCache(key, "HIT-edge", ttl);
    return build(body, contentType, ttl, "HIT-edge");
  }

  const fresh = await handler();
  if (fresh.status !== 200) return fresh; // never cache 400/404/5xx

  // Read the body once, then build each Response from the string. Avoids the
  // body-already-consumed traps that come with clone() on a streamed response.
  const body = await fresh.text();
  const contentType = fresh.headers.get("Content-Type") ?? "application/json";

  remember(key, body, contentType, ttl.edge);
  ctx.waitUntil(cache.put(cacheRequest, build(body, contentType, ttl, null)));
  logCache(key, "MISS", ttl);

  return build(body, contentType, ttl, "MISS");
}

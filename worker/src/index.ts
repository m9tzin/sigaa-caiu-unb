import type { Env } from "./types";
import { performHealthCheck } from "./health";
import {
  saveCheck,
  getLastNChecks,
  manageIncidents,
  cleanupOldChecks,
  saveOtherServiceChecks,
  rollupIsEmpty,
  recomputeRollup,
} from "./db";
import { checkAllOtherServices } from "./other-services";
import { notifyIfNeeded } from "./notify";
import { handleApiRequest } from "./api";
import { withCors, handlePreflight } from "./cors";
import { withEdgeCache } from "./cache";

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const now = new Date();
    const minute = now.getUTCMinutes();

    // Cron fires every minute. Normal cadence = every 3 min.
    // But if the last check was offline (unconfirmed), run every minute
    // so we can confirm or dismiss faster.
    if (minute % 3 !== 0) {
      const lastChecks = await getLastNChecks(env.DB, 1);
      const lastWasOffline =
        lastChecks.length > 0 && lastChecks[0].status === "offline";
      if (!lastWasOffline) return; // healthy — skip this tick
    }

    const [result, otherResults] = await Promise.all([
      performHealthCheck(env, true),
      checkAllOtherServices(),
    ]);
    const lastChecks = await getLastNChecks(env.DB, 2);

    // Captured before the write batch below: saveCheck's own upsert would otherwise
    // populate check_rollup for this tick and hide the empty table from us, so the
    // deploy backfill would never fire.
    const rollupEmpty = await rollupIsEmpty(env.DB);

    await Promise.all([
      saveCheck(env.DB, result),
      saveOtherServiceChecks(env.DB, otherResults),
    ]);
    await manageIncidents(env.DB, result, lastChecks);
    ctx.waitUntil(notifyIfNeeded(env, result, lastChecks));

    // The rollup is empty on the first tick after the tables ship, and that tick
    // backfills the whole history; every later day only repairs the trailing edge.
    // Same function, so the backfill path is not dead code between deploys. This is
    // meant to fire at most once -- but only if the backfill below actually succeeds.
    // If it rejects, the table is NOT still empty: saveCheck above has already upserted
    // this tick's own bucket into check_rollup (that write is unconditional, separate
    // from the backfill), so rollupIsEmpty() reads false on every tick from here on and
    // this branch never runs again. The bulk of the history then never gets backfilled,
    // with nothing anywhere to say so. See Task 9 Step 4 in the plan for the actual
    // recovery -- waiting for a later tick cannot fix this.
    if (rollupEmpty) {
      // Fire-and-forget on purpose (the tick must not block on ~0.5-0.9M rows of
      // reads), but not silent: an uncaught rejection here used to vanish entirely, so
      // the failure above could run forever with nothing to see in `wrangler tail`.
      ctx.waitUntil(
        recomputeRollup(env.DB, {
          // Bounded, not null: a null window does 3 full scans of checks plus 2 of
          // other_service_checks in one batch -- roughly 0.5-0.9M rows in a single
          // tick on this account, which hit Cloudflare's row-read cap (error 7500)
          // during Task 8. These are exactly the retention windows cleanupOldChecks
          // already enforces, so nothing readable is lost, and '15m' stops backfilling
          // ~17k rows that the very next 03:00 cleanup would delete anyway.
          check: { "15m": "-100 days", "1h": "-100 days", "1d": "-400 days" },
          service: "-40 days",
        }).catch(err => console.error("backfill do rollup falhou:", err))
      );
    }

    // Independent of the bootstrap branch above: a tick that finds the rollup empty
    // still needs its retention pass at 03:00, and skipping it there was unintended.
    if (now.getUTCHours() === 3 && minute < 5) {
      // The bootstrap above already covers the trailing edge with a wider window, so
      // repairing it again here would be redundant work on the same tick.
      if (!rollupEmpty) ctx.waitUntil(recomputeRollup(env.DB, "-2 days"));
      ctx.waitUntil(cleanupOldChecks(env.DB));
    }
  },

  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const origin = "*";

    if (request.method === "OPTIONS") {
      return handlePreflight(origin);
    }

    if (request.method !== "GET") {
      return withCors(
        new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { "Content-Type": "application/json" },
        }),
        origin
      );
    }

    // CORS is applied after the cache so the stored copy stays header-free; the
    // value is a constant "*", but keeping it outside means a future per-origin
    // policy can't be served from one origin's cached entry to another.
    const response = await withEdgeCache(request, ctx, () =>
      handleApiRequest(request, env)
    );
    return withCors(response, origin);
  },
};

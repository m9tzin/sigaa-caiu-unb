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

    // The rollup is empty exactly once: on the first tick after the tables ship. That
    // tick backfills the whole history; every later day only repairs the trailing edge.
    // Same function, so the backfill path is not dead code between deploys.
    if (rollupEmpty) {
      ctx.waitUntil(recomputeRollup(env.DB, null));
    } else if (now.getUTCHours() === 3 && minute < 5) {
      ctx.waitUntil(recomputeRollup(env.DB, "-2 days"));
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

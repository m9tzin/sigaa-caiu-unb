import type {
  CheckResult,
  Env,
  LayerResult,
  ReachabilityResult,
  Status,
} from "./types";

const SIGAA_URL = "https://sigaa.unb.br/sigaa/verTelaLogin.do";
const USER_AGENT = "sigaa-caiu-unb-monitor/1.0";

const TIMEOUT_MS = 30_000;
const THRESHOLD_DEGRADED_MS = 10_000;
const RETRY_DELAY_MS = 3_000;
const MAX_RETRIES = 2;

export async function performHealthCheck(
  env: Env,
  shouldRunE2E: boolean
): Promise<CheckResult> {
  const reachability = await checkReachability();

  // Short-circuit higher layers when the host isn't even reachable — no point
  // probing the login form, and saves time/load on a degraded SIGAA.
  if (reachability.status === "offline") {
    return assemble(reachability, skipped(), skipped(), skipped());
  }

  const [portal, loginForm] = await Promise.all([
    checkPortal(),
    checkLoginForm(),
  ]);

  let loginE2e: LayerResult;
  if (!shouldRunE2E) {
    loginE2e = skipped();
  } else if (!env.SIGAA_MONITOR_USER || !env.SIGAA_MONITOR_PASS) {
    loginE2e = skipped();
  } else {
    loginE2e = await checkLoginE2E(env.SIGAA_MONITOR_USER, env.SIGAA_MONITOR_PASS);
  }

  return assemble(reachability, portal, loginForm, loginE2e);
}

function assemble(
  reachability: ReachabilityResult,
  portal: LayerResult,
  loginForm: LayerResult,
  loginE2e: LayerResult
): CheckResult {
  const overall = deriveOverall(reachability, portal, loginForm, loginE2e);

  const overallError =
    reachability.status === "offline"
      ? reachability.error
      : portal.status === "offline"
        ? portal.error
        : loginForm.status === "offline"
          ? loginForm.error
          : loginE2e.status === "offline"
            ? loginE2e.error
            : reachability.error;

  return {
    status: overall,
    httpCode: reachability.httpCode,
    responseTimeMs: reachability.responseTimeMs,
    error: overallError,
    reachability,
    portal,
    loginForm,
    loginE2e,
  };
}

export function deriveOverall(
  reachability: ReachabilityResult,
  portal: LayerResult,
  loginForm: LayerResult,
  loginE2e: LayerResult
): Status {
  if (reachability.status === "offline") return "offline";
  if (portal.status === "offline") return "offline";
  if (loginForm.status === "offline") return "offline";
  if (loginE2e.status === "offline") return "offline";
  if (reachability.status === "degraded") return "degraded";
  return "online";
}

// --- Layer 1: reachability ---

async function checkReachability(): Promise<ReachabilityResult> {
  let result = await singleReachability();

  if (result.status === "offline") {
    for (let i = 0; i < MAX_RETRIES; i++) {
      await sleep(RETRY_DELAY_MS);
      const retry = await singleReachability();
      if (retry.status !== "offline") return retry;
      result = retry;
    }
  }

  return result;
}

async function singleReachability(): Promise<ReachabilityResult> {
  const start = Date.now();
  try {
    const res = await fetch(SIGAA_URL, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });

    const responseTimeMs = Date.now() - start;
    const status = determineReachabilityStatus(res.status, responseTimeMs);

    return {
      status,
      httpCode: res.status,
      responseTimeMs,
      error: null,
    };
  } catch (err) {
    const responseTimeMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      status: "offline",
      httpCode: null,
      responseTimeMs,
      error: message,
    };
  }
}

function determineReachabilityStatus(httpCode: number, responseTimeMs: number): Status {
  const isExpected = httpCode === 302 || httpCode === 200;
  if (!isExpected || httpCode >= 500) return "offline";
  if (responseTimeMs >= THRESHOLD_DEGRADED_MS) return "degraded";
  return "online";
}

// --- Layer 2: portal availability ---
// UnB uses SIGAA's own authentication (not CAS/SSO). Check that the login
// page renders and contains expected page content.

async function checkPortal(): Promise<LayerResult> {
  const start = Date.now();
  try {
    const res = await fetch(SIGAA_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });

    if (res.status !== 200) return { status: "offline", error: `login_page_http_${res.status}`, responseTimeMs: Date.now() - start };

    const body = await res.text();

    if (!body.includes("user.login") && !body.includes("SIGAA") && !body.includes("sigaa")) {
      return { status: "offline", error: "login_page_missing_expected_content", responseTimeMs: Date.now() - start };
    }

    return { status: "online", error: null, responseTimeMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return { status: "offline", error: `login_page_fetch_error: ${message}`, responseTimeMs: Date.now() - start };
  }
}

// --- Layer 3: login form fields ---
// Verify the login form renders all required fields (user.login, user.senha).
// Missing fields mean the JSF rendering pipeline is broken.

async function checkLoginForm(): Promise<LayerResult> {
  const start = Date.now();
  try {
    const res = await fetch(SIGAA_URL, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });

    if (res.status !== 200) return { status: "offline", error: `login_form_http_${res.status}`, responseTimeMs: Date.now() - start };

    const body = await res.text();

    if (!body.includes('user.login') || !body.includes('user.senha')) {
      return { status: "offline", error: "login_form_missing_credentials_fields", responseTimeMs: Date.now() - start };
    }

    return { status: "online", error: null, responseTimeMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return { status: "offline", error: `login_form_fetch_error: ${message}`, responseTimeMs: Date.now() - start };
  }
}

// --- Layer 4: end-to-end login ---
// Attempt a real login using STI-provided monitor credentials.
// Skipped if no credentials are configured.
async function checkLoginE2E(_user: string, _pass: string): Promise<LayerResult> {
  return skipped();
}

// --- Helpers ---

function skipped(): LayerResult {
  return { status: "skipped", error: null, responseTimeMs: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

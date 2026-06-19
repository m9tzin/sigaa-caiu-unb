import type { OtherServiceDef, OtherServiceCheckResult, Status } from "./types";

export const OTHER_SERVICES: OtherServiceDef[] = [
  { id: "matriculaweb", name: "Matrícula Web", url: "https://matriculaweb.unb.br/" },
  { id: "bce", name: "Biblioteca (BCE)", url: "https://bce.unb.br/" },
];

const TIMEOUT_MS = 15_000;
const THRESHOLD_DEGRADED_MS = 10_000;
const USER_AGENT = "sigaa-caiu-unb-monitor/1.0";

async function checkService(svc: OtherServiceDef): Promise<OtherServiceCheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(svc.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });
    const responseTimeMs = Date.now() - start;

    let status: Status;
    if (res.status >= 500) {
      status = "offline";
    } else if (responseTimeMs >= THRESHOLD_DEGRADED_MS) {
      status = "degraded";
    } else {
      status = "online";
    }

    return { serviceId: svc.id, status, httpCode: res.status, responseTimeMs, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return {
      serviceId: svc.id,
      status: "offline",
      httpCode: null,
      responseTimeMs: Date.now() - start,
      error: message,
    };
  }
}

export function checkAllOtherServices(): Promise<OtherServiceCheckResult[]> {
  return Promise.all(OTHER_SERVICES.map(checkService));
}

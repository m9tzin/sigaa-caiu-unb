import type {
  StatusResponse,
  HistoryResponse,
  StatsResponse,
  IncidentsResponse,
  OtherServicesResponse,
  OtherServicesHistoryResponse,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

export function fetchStatus(): Promise<StatusResponse> {
  return fetchApi("/api/status");
}

export function fetchHistory(
  period: "24h" | "7d" | "30d" | "90d"
): Promise<HistoryResponse> {
  return fetchApi(`/api/history?period=${period}`);
}

export function fetchStats(): Promise<StatsResponse> {
  return fetchApi("/api/stats");
}

export function fetchIncidents(): Promise<IncidentsResponse> {
  return fetchApi("/api/incidents");
}

export function fetchOtherServices(): Promise<OtherServicesResponse> {
  return fetchApi("/api/other-services");
}

export function fetchOtherServicesHistory(period: "24h" | "7d" | "30d"): Promise<OtherServicesHistoryResponse> {
  return fetchApi(`/api/other-services/history?period=${period}`);
}

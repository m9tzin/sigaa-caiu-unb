"use client";

import type { HistoryResponse, StatsResponse, Check, Incident } from "@/lib/types";
import { useTheme } from "@/lib/ThemeContext";

interface Props {
  history: HistoryResponse | null;
  stats: StatsResponse | null;
  incidents: Incident[] | null;
}

function groupChecksByDay(checks: Check[]): Map<string, Check[]> {
  const days = new Map<string, Check[]>();
  for (const check of checks) {
    const day = check.timestamp.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day)!.push(check);
  }
  return days;
}

function dayStatus(checks: Check[]): "online" | "degraded" | "offline" {
  let hasConsecutiveOffline = false;
  let hasIsolatedOffline = false;
  const hasDegraded = checks.some((c) => c.status === "degraded");

  for (let i = 0; i < checks.length; i++) {
    if (checks[i].status === "offline") {
      const prevOffline = i > 0 && checks[i - 1].status === "offline";
      const nextOffline = i < checks.length - 1 && checks[i + 1].status === "offline";
      if (prevOffline || nextOffline) {
        hasConsecutiveOffline = true;
      } else {
        hasIsolatedOffline = true;
      }
    }
  }

  if (hasConsecutiveOffline) return "offline";
  if (hasIsolatedOffline || hasDegraded) return "degraded";
  return "online";
}

function hasIncidentOnDay(date: string, incidents: Incident[]): boolean {
  for (const inc of incidents) {
    const start = inc.started_at.slice(0, 10);
    const end = (inc.ended_at ?? inc.started_at).slice(0, 10);
    if (date >= start && date <= end) return true;
  }
  return false;
}

export function UptimeBars({ history, stats, incidents }: Props) {
  const { theme } = useTheme();
  const isSigaa = theme === "sigaa";

  const days: { date: string; status: "online" | "degraded" | "offline" | "empty" }[] = [];
  const checksMap = history ? groupChecksByDay(history.checks) : new Map();
  const incidentList = incidents ?? [];

  for (let i = 89; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayChecks = checksMap.get(dateStr);

    if (dayChecks && dayChecks.length > 0) {
      if (hasIncidentOnDay(dateStr, incidentList)) {
        days.push({ date: dateStr, status: "offline" });
      } else {
        days.push({ date: dateStr, status: dayStatus(dayChecks) });
      }
    } else {
      days.push({ date: dateStr, status: "empty" });
    }
  }

  const uptime24h = stats?.periods["24h"]?.uptimePercent;

  const mutedClass = isSigaa ? "text-sigaa-muted" : "text-neutral-500";
  const labelClass = isSigaa ? "text-sigaa-muted" : "text-neutral-600";

  const emptyBarClass = "bg-neutral-200";

  const barColors = {
    online: "bg-green-500",
    degraded: "bg-yellow-500",
    offline: "bg-red-500",
    empty: emptyBarClass,
  };

  const dotShape = isSigaa ? "rounded-sm" : "rounded-full";

  const barsContent = (
    <>
      <div className="flex gap-[2px]">
        {days.map((day, i) => (
          <div
            key={i}
            className={`flex-1 rounded-sm ${barColors[day.status]} transition-all hover:opacity-80`}
            style={{ height: "32px" }}
            title={`${day.date}: ${day.status === "empty" ? "sem dados" : day.status}`}
          />
        ))}
      </div>

      <div className={`flex justify-between mt-2 text-xs ${labelClass}`}>
        <span>90 dias atras</span>
        <span>Hoje</span>
      </div>

      <div className={`flex gap-4 mt-3 text-xs ${mutedClass} justify-center`}>
        <span className="flex items-center gap-1">
          <span className={`w-2 h-2 ${dotShape} bg-green-500`} /> Online
        </span>
        <span className="flex items-center gap-1">
          <span className={`w-2 h-2 ${dotShape} bg-yellow-500`} /> Lento
        </span>
        <span className="flex items-center gap-1">
          <span className={`w-2 h-2 ${dotShape} bg-red-500`} /> Offline
        </span>
        <span className="flex items-center gap-1">
          <span className={`w-2 h-2 ${dotShape} ${emptyBarClass}`} /> Sem dados
        </span>
      </div>
    </>
  );

  if (isSigaa) {
    return (
      <div className="institutional-panel">
        <div className="institutional-panel-header flex items-center justify-between">
          <span>Histórico de status</span>
          {uptime24h !== undefined && (
            <span className="text-xs font-normal opacity-90">{uptime24h}% uptime (24h)</span>
          )}
        </div>
        <div className="p-4">{barsContent}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-neutral-700">Historico de status</h3>
        {uptime24h !== undefined && (
          <span className="text-sm text-neutral-500">{uptime24h}% uptime (24h)</span>
        )}
      </div>
      {barsContent}
    </div>
  );
}

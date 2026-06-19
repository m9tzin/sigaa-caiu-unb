"use client";

import { useState, useEffect } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { OtherServicesHistoryCheck } from "@/lib/types";
import { fetchOtherServicesHistory } from "@/lib/api";
import { useTheme } from "@/lib/ThemeContext";
import { institutionalTheme } from "@/lib/institutionalTheme";

type Period = "24h" | "7d" | "30d";

const SERVICES = [
  { key: "matriculaweb_ms" as const, label: "Matrícula Web", color: "#f97316" },
  { key: "bce_ms" as const, label: "Biblioteca (BCE)", color: "#3b82f6" },
];

function formatTime(timestamp: string, period: Period): string {
  const date = new Date(timestamp);
  const options: Intl.DateTimeFormatOptions =
    period === "24h"
      ? { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }
      : { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" };
  return date.toLocaleString("pt-BR", options);
}

function formatMs(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export function OtherServicesChart() {
  const { theme } = useTheme();
  const isSigaa = theme === "sigaa";
  const [period, setPeriod] = useState<Period>("24h");
  const [histories, setHistories] = useState<Record<Period, OtherServicesHistoryCheck[] | null>>({ "24h": null, "7d": null, "30d": null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (histories[period] !== null) return;
    setLoading(true);
    fetchOtherServicesHistory(period)
      .then(res => setHistories(prev => ({ ...prev, [period]: res.checks })))
      .catch(() => setHistories(prev => ({ ...prev, [period]: [] })))
      .finally(() => setLoading(false));
  }, [period, histories]);

  const data = (histories[period] ?? []).map(c => ({
    time: formatTime(c.timestamp, period),
    matriculaweb_ms: c.matriculaweb_ms,
    bce_ms: c.bce_ms,
  }));

  const activeServices = SERVICES.filter(s => data.some(d => d[s.key] != null));

  const periodButtons = (["24h", "7d", "30d"] as Period[]).map(p => (
    <button
      key={p}
      onClick={() => setPeriod(p)}
      className={`transition-colors ${
        isSigaa
          ? `px-2 py-0.5 text-xs border ${period === p ? "bg-sigaa-primary text-white border-sigaa-primary" : "bg-white text-sigaa-primary border-sigaa-border-blue hover:bg-sigaa-secondary"}`
          : `px-3 py-1 text-xs rounded-md ${period === p ? "bg-neutral-200 text-neutral-900" : "text-neutral-400 hover:text-neutral-600"}`
      }`}
    >
      {p}
    </button>
  ));

  const chartContent = loading ? (
    <div className={`h-48 flex items-center justify-center text-sm ${isSigaa ? "text-sigaa-muted" : "text-neutral-400"}`}>
      Carregando...
    </div>
  ) : data.length === 0 || activeServices.length === 0 ? (
    <div className={`h-48 flex items-center justify-center text-sm ${isSigaa ? "text-sigaa-muted" : "text-neutral-400"}`}>
      Sem dados para este periodo
    </div>
  ) : (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke={isSigaa ? institutionalTheme.colors.borders.default : "#e5e5e5"} />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: isSigaa ? institutionalTheme.colors.text.muted : "#a3a3a3" }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tick={{ fontSize: 11, fill: isSigaa ? institutionalTheme.colors.text.muted : "#a3a3a3" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => formatMs(v)}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: isSigaa ? institutionalTheme.colors.panelBackground : "#fff",
            border: `1px solid ${isSigaa ? institutionalTheme.colors.borders.default : "#e5e5e5"}`,
            borderRadius: isSigaa ? 2 : 8,
            fontSize: 12,
            color: isSigaa ? institutionalTheme.colors.text.main : undefined,
          }}
          formatter={(value, name) => {
            const svc = SERVICES.find(s => s.key === name);
            return [formatMs(Number(value)), svc?.label ?? String(name)];
          }}
        />
        <Legend
          iconType={isSigaa ? "square" : "circle"}
          iconSize={8}
          wrapperStyle={{ fontSize: 12, color: isSigaa ? institutionalTheme.colors.text.muted : "#737373" }}
          formatter={(value: string) => SERVICES.find(s => s.key === value)?.label ?? value}
        />
        {activeServices.map(svc => (
          <Line
            key={svc.key}
            type="monotone"
            dataKey={svc.key}
            stroke={svc.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );

  if (isSigaa) {
    return (
      <div className="institutional-panel">
        <div className="institutional-panel-header flex items-center justify-between">
          <span>Tempo de resposta</span>
          <div className="flex gap-1">{periodButtons}</div>
        </div>
        <div className="p-4">{chartContent}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-neutral-700">Tempo de resposta</h3>
        <div className="flex gap-1">{periodButtons}</div>
      </div>
      {chartContent}
    </div>
  );
}

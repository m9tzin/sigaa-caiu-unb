"use client";

import { useState } from "react";
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
import type { HistoryResponse } from "@/lib/types";
import { useTheme } from "@/lib/ThemeContext";
import { institutionalTheme } from "@/lib/institutionalTheme";

type Period = "24h" | "7d" | "30d";

interface Props {
  histories: Record<Period, HistoryResponse | null>;
}

const LAYERS = [
  { key: "reachability_ms", label: "Servidor", color: "#22c55e" },
  { key: "portal_ms", label: "Portal", color: "#3b82f6" },
  { key: "login_form_ms", label: "Login", color: "#a855f7" },
  { key: "login_e2e_ms", label: "Login E2E", color: "#f97316" },
] as const;

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

export function LayerResponseChart({ histories }: Props) {
  const { theme } = useTheme();
  const isSigaa = theme === "sigaa";
  const [period, setPeriod] = useState<Period>("24h");
  const history = histories[period];

  const data =
    history?.checks.map((c) => ({
      time: formatTime(c.timestamp, period),
      reachability_ms: c.reachability_ms ?? null,
      portal_ms: c.portal_ms ?? null,
      login_form_ms: c.login_form_ms ?? null,
      login_e2e_ms: c.login_e2e_ms ?? null,
    })) ?? [];

  const activeLayers = LAYERS.filter((l) =>
    data.some((d) => d[l.key] != null)
  );

  const periodButtons = (["24h", "7d", "30d"] as Period[]).map((p) => (
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

  const chartContent = data.length === 0 || activeLayers.length === 0 ? (
    <div className={`h-48 flex items-center justify-center text-sm ${isSigaa ? "text-sigaa-muted" : "text-neutral-400"}`}>
      Sem dados para este periodo
    </div>
  ) : (
    <ResponsiveContainer width="100%" height={260}>
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
          tickFormatter={(v) => formatMs(v)}
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
            const v = Number(value);
            const layer = LAYERS.find((l) => l.key === name);
            return [formatMs(v), layer?.label ?? String(name)];
          }}
        />
        <Legend
          iconType={isSigaa ? "square" : "circle"}
          iconSize={8}
          wrapperStyle={{ fontSize: 12, color: isSigaa ? institutionalTheme.colors.text.muted : "#737373" }}
          formatter={(value: string) => {
            const layer = LAYERS.find((l) => l.key === value);
            return layer?.label ?? value;
          }}
        />
        {activeLayers.map((layer) => (
          <Line
            key={layer.key}
            type="monotone"
            dataKey={layer.key}
            stroke={layer.color}
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
          <span>Tempo de resposta por camada</span>
          <div className="flex gap-1">{periodButtons}</div>
        </div>
        <div className="p-4">{chartContent}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-neutral-700">Tempo de resposta por camada</h3>
        <div className="flex gap-1">{periodButtons}</div>
      </div>
      {chartContent}
    </div>
  );
}

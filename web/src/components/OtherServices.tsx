"use client";

import { useState } from "react";
import type { OtherService } from "@/lib/types";
import { timeAgo, formatMs } from "@/lib/utils";
import { OtherServicesChart } from "@/components/OtherServicesChart";

interface Props {
  services: OtherService[] | null;
}

function statusDotColor(status: OtherService["status"]): string {
  switch (status) {
    case "online": return "bg-green-500";
    case "degraded": return "bg-yellow-500";
    case "offline": return "bg-red-500";
    default: return "bg-neutral-300";
  }
}

function statusText(status: OtherService["status"]): string {
  switch (status) {
    case "online": return "OK";
    case "degraded": return "Lento";
    case "offline": return "Fora";
    default: return "N/A";
  }
}

function statusTextColor(status: OtherService["status"]): string {
  switch (status) {
    case "online": return "text-green-500";
    case "degraded": return "text-yellow-500";
    case "offline": return "text-red-500";
    default: return "text-neutral-400";
  }
}

function ServiceRow({ svc }: { svc: OtherService }) {
  return (
    <div className="flex items-center justify-between py-3">
      <div className="flex items-center gap-2.5">
        <div className={`w-2 h-2 rounded-full ${statusDotColor(svc.status)}`} />
        <a
          href={svc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-neutral-600 text-sm hover:text-neutral-900 transition-colors"
        >
          {svc.name}
        </a>
      </div>
      <div className="flex items-center gap-4 text-xs">
        <span className={`font-medium ${statusTextColor(svc.status)}`}>
          {statusText(svc.status)}
        </span>
        {svc.responseTimeMs != null && svc.responseTimeMs > 0 && (
          <span className="text-neutral-400 tabular-nums w-14 text-right">
            {formatMs(svc.responseTimeMs)}
          </span>
        )}
        <span className="text-neutral-300 w-16 text-right">
          {svc.timestamp ? timeAgo(svc.timestamp) : "sem dados"}
        </span>
      </div>
    </div>
  );
}

export function OtherServices({ services }: Props) {
  const [open, setOpen] = useState(false);

  if (!services) return null;

  return (
    <div className="bg-neutral-50 border border-neutral-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-neutral-700 hover:bg-neutral-100 transition-colors"
      >
        <span>Outros servicos UnB</span>
        <svg
          className={`w-4 h-4 text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-neutral-200">
          <div className="px-4 divide-y divide-neutral-100">
            {services.map(svc => (
              <ServiceRow key={svc.id} svc={svc} />
            ))}
          </div>
          <div className="border-t border-neutral-200 p-4">
            <OtherServicesChart />
          </div>
        </div>
      )}
    </div>
  );
}

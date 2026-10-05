// ShapesOS — analytics home tabs (Phase 4b): Overview (traffic, social,
// attribution, spend) and Pageviews (the Umami panel for public pages).
"use client";

import { useState } from "react";
import { BarChart3, LayoutDashboard } from "lucide-react";
import { AnalyticsHome } from "./AnalyticsHome";
import { AnalyticsPanel } from "./AnalyticsPanel";

type Tab = "overview" | "pageviews";

export function AnalyticsTabs() {
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: Array<{ id: Tab; label: string; Icon: typeof BarChart3 }> = [
    { id: "overview", label: "Overview", Icon: LayoutDashboard },
    { id: "pageviews", label: "Pageviews", Icon: BarChart3 },
  ];
  return (
    <>
      <div className="flex items-center gap-1 border-b border-line" role="tablist" aria-label="Analytics views">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[14px] font-semibold ${
              tab === id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === "overview" ? <AnalyticsHome /> : <AnalyticsPanel />}
    </>
  );
}

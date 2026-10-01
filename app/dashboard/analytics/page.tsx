// Marketr — analytics dashboard (Phase 12 "embeds").
// Umami-backed stats for public pages. Without a configured sidecar the
// panel renders an honest empty state with the compose-profile quick start.

import { BarChart3, Settings2 } from "lucide-react";
import Link from "next/link";
import { AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";

export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="aos-heading">
            Analytics
          </h1>
          <p className="mt-0.5 text-[13px] text-muted">
            Cookieless pageview analytics for public pages, powered by a
            self-hosted Umami sidecar.
          </p>
        </div>
        <Link
          href="/dashboard/settings/providers"
          className="inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
        >
          <Settings2 className="h-4 w-4" />
          Providers
        </Link>
      </div>

      <div className="flex items-center gap-1 border-b border-line">
        <span className="inline-flex items-center gap-1.5 border-b-2 border-ink px-3 py-2 text-[13px] font-medium text-ink">
          <BarChart3 className="h-4 w-4" />
          Overview
        </span>
      </div>

      <AnalyticsPanel />
    </div>
  );
}

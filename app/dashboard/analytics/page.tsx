// Marketr — analytics dashboard (Phase 12 "embeds").
// Umami-backed stats for public pages. Without a configured sidecar the
// panel renders an honest empty state with the compose-profile quick start.

import { BarChart3, Settings2 } from "lucide-react";
import Link from "next/link";
import { AnalyticsPanel } from "@/components/analytics/AnalyticsPanel";

export const dynamic = "force-dynamic";

export default function AnalyticsPage() {
  return (
    <div className="flex flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">
            Analytics
          </h1>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Cookieless pageview analytics for public pages, powered by a
            self-hosted Umami sidecar.
          </p>
        </div>
        <Link
          href="/dashboard/settings/providers"
          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50"
        >
          <Settings2 className="h-4 w-4" />
          Providers
        </Link>
      </div>

      <div className="flex items-center gap-1 border-b border-stone-200">
        <span className="inline-flex items-center gap-1.5 border-b-2 border-violet-600 px-3 py-2 text-[13px] font-medium text-violet-700">
          <BarChart3 className="h-4 w-4" />
          Overview
        </span>
      </div>

      <AnalyticsPanel />
    </div>
  );
}

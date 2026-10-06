// ShapesOS — analytics home (Phase 4b). One date range across traffic (GA4
// and Search Console through the connector layer), social engagement,
// attribution by channel and spend; the Umami pageview panel for public
// pages stays as its own tab.

import { Settings2 } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { AnalyticsTabs } from "@/components/analytics/AnalyticsTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Analytics — ShapesOS",
  description: "Traffic, social engagement, attribution and spend in one place.",
};

export default async function AnalyticsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) redirect("/dashboard");
  return (
    <div className="flex flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="aos-heading">Analytics</h1>
          <p className="mt-0.5 text-[0.8125rem] text-muted">Traffic, social engagement, attribution and spend for one date range.</p>
        </div>
        <Link
          href="/dashboard/settings/connectors"
          className="inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
        >
          <Settings2 className="h-4 w-4" />
          Connectors
        </Link>
      </div>
      <AnalyticsTabs />
    </div>
  );
}

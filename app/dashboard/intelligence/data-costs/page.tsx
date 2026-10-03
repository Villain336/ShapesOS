// Marketr — Phase 10 M6: Data costs (margin dashboard).
// Per-workspace API spend table (by vendor, by meter, period vs cap),
// volume-cache hit-rate stats, and vendor routing config (read-only +
// admin-gated default-vendor switch). House style per StudioApp.tsx.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { getDataCostSummary, currentPeriod } from "@/lib/intelligence/providers/meter";
import { getVendorConfigs, vendorEnvVars } from "@/lib/intelligence/providers/credentials";
import { vendorHealth } from "@/lib/intelligence/providers/routing";
import { getVolumeCacheStats, VOLUME_CACHE_TTL_DAYS, VOLUME_CACHE_MAX_TTL_DAYS } from "@/lib/intelligence/providers/volume";
import { DataCostsClient } from "./DataCostsClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Data costs — ShapesOS",
  description: "API spend, volume-cache hit rate, and SERP vendor routing — the Phase 10 margin dashboard.",
};

function validPeriod(p: string | undefined): string {
  return p && /^\d{4}-\d{2}$/.test(p) ? p : currentPeriod();
}

export default async function DataCostsPage({
  searchParams,
}: {
  searchParams?: Promise<{ period?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const period = validPeriod((await searchParams)?.period);
  const [summary, configs, health, cacheStats] = await Promise.all([
    getDataCostSummary(workspace.id, period),
    getVendorConfigs(workspace.id),
    vendorHealth(workspace.id),
    getVolumeCacheStats(workspace.id),
  ]);

  const isAdmin = membership.role === "owner" || membership.role === "admin";

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="aos-heading">Data costs</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            Every external data call, metered per workspace. Rent goes down when this table does.
          </p>
        </div>
      </div>
      <DataCostsClient
        period={period}
        summary={summary}
        configs={configs}
        health={health}
        cacheStats={cacheStats}
        cacheTtlDays={VOLUME_CACHE_TTL_DAYS}
        cacheMaxTtlDays={VOLUME_CACHE_MAX_TTL_DAYS}
        envVars={vendorEnvVars()}
        isAdmin={isAdmin}
      />
    </div>
  );
}

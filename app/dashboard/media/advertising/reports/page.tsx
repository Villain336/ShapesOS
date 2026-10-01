// Marketr — Phase 18 slice 1: reports placeholder.
// Unified cross-platform reporting lands in slice 6; the AdReport schema +
// normalization entry point (lib/adplatforms/reporting.ts) ship in slice 1.

import { redirect } from "next/navigation";
import { BarChart3 } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import AdsTabs from "../_components/AdsTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Ad reports — Marketr",
  description: "Unified cross-platform ad reporting.",
};

export default async function AdReportsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Reports</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Normalized daily spend, impressions, clicks, and ROAS across every platform.
        </p>
      </div>
      <AdsTabs active="reports" />
      <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white px-6 py-12 text-center">
        <BarChart3 className="h-8 w-8 text-stone-300" />
        <p className="text-[14px] font-medium text-stone-700">Unified reporting lands in slice 6</p>
        <p className="max-w-sm text-[13px] text-stone-500">
          The AdReport schema and normalization entry point are in place; each platform connector feeds it in its own slice.
        </p>
      </div>
    </div>
  );
}

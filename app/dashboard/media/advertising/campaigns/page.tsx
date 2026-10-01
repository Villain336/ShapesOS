// Marketr — Phase 18: campaigns surface (platform-agnostic).
// Every launched/approved campaign across Amazon Ads, StackAdapt, Walmart
// Connect, and the Spotify guided flow lands in one unified table, backed by
// the PaidAdCampaign rows the per-platform executors upsert. Read-only:
// spend changes still flow through the proposals inbox.

import { redirect } from "next/navigation";
import { Megaphone } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import AdsTabs from "../_components/AdsTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaigns — Marketr",
  description: "Unified campaigns across all ad platforms.",
};

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

const PLATFORM_LABELS: Record<string, string> = {
  amazon: "Amazon Ads",
  stackadapt: "StackAdapt",
  walmart: "Walmart Connect",
  spotify: "Spotify",
};

const STATUS_STYLES: Record<string, string> = {
  live: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  paused: "bg-amber-50 text-amber-700 ring-amber-200",
  draft: "bg-stone-100 text-stone-600 ring-stone-200",
};

export default async function CampaignsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const campaigns = await prisma.paidAdCampaign.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { updatedAt: "desc" },
    include: { account: { select: { name: true, externalAccountId: true } } },
    take: 200,
  });

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Campaigns</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — every campaign launched through an approved proposal, across all platforms.
        </p>
      </div>
      <AdsTabs active="campaigns" />
      {campaigns.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white px-6 py-12 text-center">
          <Megaphone className="h-8 w-8 text-stone-300" />
          <p className="text-[14px] font-medium text-stone-700">No campaigns yet</p>
          <p className="max-w-sm text-[13px] text-stone-500">
            Campaigns appear here after their launch proposal is approved and executed. Nothing spends without that step.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Platform</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">External ID</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Budget</th>
                <th className="px-3 py-2 font-medium">Flight</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const badge = STATUS_STYLES[c.status] ?? STATUS_STYLES.draft;
                return (
                  <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/60">
                    <td className="px-3 py-2.5 font-medium text-stone-900">{c.name}</td>
                    <td className="px-3 py-2.5 text-stone-600">
                      {PLATFORM_LABELS[c.platformKey] ?? c.platformKey}
                    </td>
                    <td className="px-3 py-2.5 text-stone-600">
                      {c.account.name ?? c.account.externalAccountId}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-stone-500">
                      {c.externalId ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${badge}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-stone-700">
                      {money(c.budgetCents)}
                    </td>
                    <td className="px-3 py-2.5 text-stone-500">
                      {c.flightStart || c.flightEnd ? `${fmtDate(c.flightStart)} → ${fmtDate(c.flightEnd)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

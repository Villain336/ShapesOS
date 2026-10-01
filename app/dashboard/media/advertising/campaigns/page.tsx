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

// Campaign statuses are not agent states — neutrals with text labels only.
const STATUS_BADGES: Record<string, string> = {
  live: "bg-ink text-white",
  paused: "border border-line bg-paper text-muted",
  draft: "border border-line bg-paper text-muted",
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Campaigns</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — every campaign launched through an approved proposal, across all platforms.
        </p>
      </div>
      <AdsTabs active="campaigns" />
      {campaigns.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
          <Megaphone className="h-8 w-8 text-subtle" />
          <p className="text-md font-semibold text-ink">No campaigns yet</p>
          <p className="max-w-sm text-sm text-muted">
            Campaigns appear here after their launch proposal is approved and executed. Nothing spends without that step.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas">
                <th className="px-3 py-2 text-xs font-semibold text-muted">Campaign</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Platform</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Account</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">External ID</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Status</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Budget</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Flight</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const badge = STATUS_BADGES[c.status] ?? STATUS_BADGES.draft;
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2.5 font-semibold text-ink">{c.name}</td>
                    <td className="px-3 py-2.5 text-muted">
                      {PLATFORM_LABELS[c.platformKey] ?? c.platformKey}
                    </td>
                    <td className="px-3 py-2.5 text-muted">
                      {c.account.name ?? c.account.externalAccountId}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-sm text-muted">
                      {c.externalId ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex h-badge items-center rounded-full px-2.5 text-sm font-semibold ${badge}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-ink">
                      {money(c.budgetCents)}
                    </td>
                    <td className="px-3 py-2.5 text-muted">
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

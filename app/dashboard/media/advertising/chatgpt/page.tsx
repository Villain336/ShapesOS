// Marketr — Wave 2 ChatGPT Ads slice 2: ChatGPT campaigns page (Grow pillar → Advertising).
//
// Conversational-intent campaigns bought through the StackAdapt rail.
// Campaign list (dense table) + proposal form. Every spend action flows
// through the Phase 18 proposal inbox — this page never executes spend.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { ensureAdPlatforms } from "@/lib/adplatforms/oauth";
import { adsManagerDeepLink } from "@/lib/adplatforms/chatgpt/types";
import AdsTabs from "../_components/AdsTabs";
import ProposeCampaignForm from "./_components/ProposeCampaignForm";
import LaunchChecklistPanel from "./_components/LaunchChecklistPanel";
import PauseControls from "./_components/PauseControls";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ChatGPT Ads — Marketr",
  description: "Propose, approve, and measure conversational-intent campaigns bought through StackAdapt.",
};

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";
const chipSlate = `${chip} bg-stone-100 text-stone-600 border-stone-200`;
const chipBrand = `${chip} bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20`;
const chipGreen = `${chip} bg-emerald-50 text-emerald-700 border-emerald-200`;
const chipAmber = `${chip} bg-amber-50 text-amber-700 border-amber-200`;

function statusChip(status: string) {
  if (status === "live") return <span className={chipGreen}>live</span>;
  if (status === "proposed" || status === "approved") return <span className={chipAmber}>{status}</span>;
  return <span className={chipSlate}>{status}</span>;
}

function fmtCents(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export default async function ChatGPTAdsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  await ensureAdPlatforms(workspace.id);
  const [accounts, campaigns] = await Promise.all([
    prisma.adAccount.findMany({
      where: {
        workspaceId: workspace.id,
        status: "connected",
        platform: { key: "stackadapt" },
      },
      select: { id: true, name: true, externalAccountId: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.chatGPTCampaign.findMany({
      where: { workspaceId: workspace.id },
      include: {
        campaign: { select: { id: true, name: true, externalId: true } },
        creatives: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  // Latest launch proposal per paid campaign — the launch checklist needs it.
  const launchProposals = await prisma.spendProposal.findMany({
    where: {
      workspaceId: workspace.id,
      kind: "launch",
      targetType: "campaign",
      targetId: { in: campaigns.map((c) => c.campaign.id) },
    },
    select: { id: true, targetId: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const approvedProposalByTarget = new Map<string, string>();
  for (const p of launchProposals) {
    if (p.status === "approved" && !approvedProposalByTarget.has(p.targetId)) {
      approvedProposalByTarget.set(p.targetId, p.id);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">ChatGPT Ads</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — conversational-intent campaigns, bought through your StackAdapt account.
          Propose here, approve in the inbox, spend executes only after your approval.
        </p>
      </div>

      <AdsTabs active="campaigns" />

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 bg-stone-50 px-3 py-2 text-[12px] font-medium text-stone-600">
          Campaigns
        </div>
        {campaigns.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-stone-500">
            No ChatGPT campaigns yet — propose the first one below.
          </p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Tiers</th>
                <th className="px-3 py-2 font-medium">Daily</th>
                <th className="px-3 py-2 font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Creatives</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2.5 font-medium text-stone-900">{c.campaign.name}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex gap-1">
                      {c.targetTiers.map((t) => (
                        <span key={t} className={chipBrand}>{t}</span>
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-stone-600">{fmtCents(c.budgetDailyCents)}</td>
                  <td className="px-3 py-2.5 text-stone-600">{fmtCents(c.budgetTotalCents)}</td>
                  <td className="px-3 py-2.5 text-stone-600">{c.creatives.length}</td>
                  <td className="px-3 py-2.5">{statusChip(c.status)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <a
                      href={adsManagerDeepLink({ campaignName: c.campaign.name })}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[12px] font-medium text-[var(--brand-700)] underline"
                    >
                      Ads Manager
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 bg-stone-50 px-3 py-2 text-[12px] font-medium text-stone-600">
          Propose a campaign
        </div>
        <div className="p-3">
          <ProposeCampaignForm accounts={accounts} />
        </div>
      </div>

      {campaigns
        .filter((c) => c.status === "approved" || c.status === "live")
        .map((c) => (
          <div key={c.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div className="border-b border-stone-200 bg-stone-50 px-3 py-2 text-[12px] font-medium text-stone-600">
              {c.status === "approved" ? "Launch" : "Live controls"} — {c.campaign.name}
            </div>
            <div className="p-3">
              {c.status === "approved" ? (
                <LaunchChecklistPanel
                  campaignId={c.id}
                  proposalId={approvedProposalByTarget.get(c.campaign.id) ?? null}
                  targetTiers={c.targetTiers}
                  dailyCapCents={c.budgetDailyCents}
                />
              ) : (
                <PauseControls campaignId={c.id} />
              )}
            </div>
          </div>
        ))}

      <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-500">
        There is no public OpenAI ads API — buying runs through StackAdapt and the{" "}
        <a href="https://ads.openai.com/" target="_blank" rel="noreferrer" className="underline">
          Ads Manager console
        </a>
        . Marketr never holds ad spend; your StackAdapt account bills you directly.{" "}
        <Link href="/dashboard/media/advertising/proposals" className="underline">
          Open the proposal inbox
        </Link>
        .
      </div>
    </div>
  );
}

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
import {
  computeCpaDrift,
  getChatGPTReportRows,
  summarizeAdRows,
} from "@/lib/adplatforms/chatgpt/reporting";
import AdsTabs from "../_components/AdsTabs";
import ProposeCampaignForm from "./_components/ProposeCampaignForm";
import LaunchChecklistPanel from "./_components/LaunchChecklistPanel";
import PauseControls from "./_components/PauseControls";
import ReportPanel from "./_components/ReportPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "ChatGPT Ads — Marketr",
  description: "Propose, approve, and measure conversational-intent campaigns bought through StackAdapt.",
};

const chip =
  "inline-flex h-badge items-center whitespace-nowrap rounded-full border border-line bg-paper px-2.5 text-sm font-semibold text-muted";
const chipBase =
  "inline-flex h-badge items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold";

function statusChip(status: string) {
  // Approval states follow the approval-flow mapping; campaign statuses
  // (live, paused, ended) are not agent states — neutrals only.
  if (status === "live") return <span className={`${chipBase} bg-ink text-white`}>live</span>;
  if (status === "proposed")
    return (
      <span className={`${chipBase} bg-needs text-ink`}>
        <span
          className="aos-shape aos-shape--needs"
          style={{ color: "var(--aos-ink)" }}
          role="img"
          aria-label="Needs review"
        />
        proposed
      </span>
    );
  if (status === "approved")
    return (
      <span className={`${chipBase} bg-done text-white`}>
        <span
          className="aos-shape aos-shape--done"
          style={{ color: "var(--aos-on-done)" }}
          role="img"
          aria-label="Approved"
        />
        approved
      </span>
    );
  return <span className={chip}>{status}</span>;
}

function fmtCents(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const cardCls = "overflow-hidden rounded-lg bg-paper shadow-hairline";
const cardBand = "border-b border-line px-3 py-2 text-xs font-semibold text-muted";

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

  // Report data for campaigns that have run (read-only drift display — the
  // pull-report route is what raises variance alerts).
  const reportData = await Promise.all(
    campaigns
      .filter((c) => ["live", "paused", "ended"].includes(c.status))
      .map(async (c) => {
        const rows = await getChatGPTReportRows(workspace.id, c.campaign.id, 14);
        return {
          id: c.id,
          name: c.campaign.name,
          summary: summarizeAdRows(rows),
          drift: computeCpaDrift(rows),
        };
      }),
  );

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">ChatGPT Ads</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name} — conversational-intent campaigns, bought through your StackAdapt account.
          Propose here, approve in the inbox, spend executes only after your approval.
        </p>
      </div>

      <AdsTabs active="campaigns" />

      <div className={cardCls}>
        <div className={cardBand}>Campaigns</div>
        {campaigns.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted">
            No ChatGPT campaigns yet — propose the first one below.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas">
                <th className="px-3 py-2 text-xs font-semibold text-muted">Campaign</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Tiers</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Daily</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Total</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Creatives</th>
                <th className="px-3 py-2 text-xs font-semibold text-muted">Status</th>
                <th className="px-3 py-2 text-right text-xs font-semibold text-muted">Action</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2.5 font-semibold text-ink">{c.campaign.name}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex gap-1.5">
                      {c.targetTiers.map((t) => (
                        <span key={t} className={chip}>{t}</span>
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{fmtCents(c.budgetDailyCents)}</td>
                  <td className="px-3 py-2.5 text-muted">{fmtCents(c.budgetTotalCents)}</td>
                  <td className="px-3 py-2.5 text-muted">{c.creatives.length}</td>
                  <td className="px-3 py-2.5">{statusChip(c.status)}</td>
                  <td className="px-3 py-2.5 text-right">
                    <a
                      href={adsManagerDeepLink({ campaignName: c.campaign.name })}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-semibold text-ink underline underline-offset-2"
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

      <div className={cardCls}>
        <div className={cardBand}>Propose a campaign</div>
        <div className="p-3">
          <ProposeCampaignForm accounts={accounts} />
        </div>
      </div>

      {campaigns
        .filter((c) => c.status === "approved" || c.status === "live")
        .map((c) => (
          <div key={c.id} className={cardCls}>
            <div className={cardBand}>
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

      {reportData.map((r) => (
        <div key={r.id} className={cardCls}>
          <div className={cardBand}>Report — {r.name}</div>
          <div className="p-3">
            <ReportPanel
              campaignId={r.id}
              summary={r.summary}
              variance={{
                flagged: r.drift.flaggable,
                driftRatio: r.drift.driftRatio,
                recentCpaCents: r.drift.recentCpaCents,
                priorCpaCents: r.drift.priorCpaCents,
                reason: r.drift.reason,
              }}
            />
          </div>
        </div>
      ))}

      <div className="rounded-lg bg-paper px-3 py-2 text-sm text-muted shadow-hairline">
        There is no public OpenAI ads API — buying runs through StackAdapt and the{" "}
        <a href="https://ads.openai.com/" target="_blank" rel="noreferrer" className="font-semibold text-ink underline underline-offset-2">
          Ads Manager console
        </a>
        . Marketr never holds ad spend; your StackAdapt account bills you directly.{" "}
        <Link href="/dashboard/media/advertising/proposals" className="font-semibold text-ink underline underline-offset-2">
          Open the proposal inbox
        </Link>
        . Server-side conversion events (Conversions API) are built with hashed identifiers only —
        sending one requires your explicit acceptance of OpenAI&apos;s ads data terms per event.
      </div>
    </div>
  );
}

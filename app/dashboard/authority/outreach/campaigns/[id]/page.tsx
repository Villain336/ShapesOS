// Marketr — O1 campaign detail (Phase 6).
// Prospects with quality/relevance scores, sequence status per prospect,
// reply inbox, and placement verification alerts. Light mode, no emoji.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";
import {
  prismaCampaignStore, prismaDomainStore, prismaProspectStore, prismaSequenceStore,
  isDraftExpired, DRAFT_EXPIRY_DAYS,
} from "@/lib/authority/outreach";
import {
  ArrowLeft, Users, TriangleAlert, BadgeCheck, Hourglass,
  Inbox, Link2, ExternalLink,
} from "lucide-react";
import {
  DiscoverButton, QualifyButton, DraftSequenceForm, SendSequenceButton,
  VerifyPlacementButton, ActivateShallowButton, Depth3ActivationPanel,
} from "../../_components/OutreachActions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Outreach campaign — Marketr",
  description: "Prospects, sequences, replies, and placement verification for one campaign.",
};


const STATUS_CHIP: Record<string, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  draft: "border-stone-200 bg-stone-50 text-stone-600",
  new: "border-stone-200 bg-stone-50 text-stone-600",
  qualified: "border-violet-200 bg-violet-50 text-violet-700",
  contacted: "border-violet-200 bg-violet-50 text-violet-700",
  replied: "border-emerald-200 bg-emerald-50 text-emerald-700",
  placed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  bounced: "border-red-200 bg-red-50 text-red-700",
  suppressed: "border-red-200 bg-red-50 text-red-700",
  declined: "border-stone-200 bg-stone-50 text-stone-600",
};

function chip(text: string, key: string) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${STATUS_CHIP[key] ?? "border-stone-200 bg-stone-50 text-stone-600"}`}>
      {text}
    </span>
  );
}



const SEQ_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sending: "Sending",
  stopped: "Stopped (reply)",
  paused: "Paused (deliverability)",
  expired: "Expired",
  completed: "Completed",
};

function ScoreCell({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-stone-100">
        <span className="block h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </span>
      <span className="font-medium text-stone-700">{value}</span>
    </div>
  );
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = roleAtLeast(membership.role, "editor");
  const { id } = await params;

  const ready = await authorityTablesReady().catch(() => false);
  const campaignStore = prismaCampaignStore();
  const prospectStore = prismaProspectStore();
  const sequenceStore = prismaSequenceStore();
  const domainStore = prismaDomainStore();

  const campaign = ready ? await campaignStore.get(id, workspace.id).catch(() => null) : null;
  if (!campaign) {
    return (
      <div className="p-6 text-sm text-stone-600">
        Campaign not found.{" "}
        <Link href="/dashboard/authority/outreach" className="underline">Back to outreach</Link>
      </div>
    );
  }
  const domain = campaign.sendingDomainId
    ? await domainStore.get(campaign.sendingDomainId, workspace.id).catch(() => null)
    : null;
  const prospects = await prospectStore.list(workspace.id, campaign.id).catch(() => []);
  const sequences = await sequenceStore.list(workspace.id, campaign.id).catch(() => []);
  const seqByProspect = new Map(sequences.map((s) => [s.prospectId, s]));

  // Aggregate events across sequences: replies (inbox) + placement alerts.
  const replies: { sequenceId: string; prospectId: string; replyId: string; ts: Date }[] = [];
  const placementAlerts: { sequenceId: string; prospectId: string; outcome: string; detail: string; ts: Date }[] = [];
  for (const s of sequences) {
    const events = await sequenceStore.events(s.id, workspace.id).catch(() => []);
    for (const e of events) {
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      if (e.event === "replied") {
        replies.push({ sequenceId: s.id, prospectId: s.prospectId, replyId: String(detail.replyId ?? ""), ts: e.ts });
      }
      if (e.event === "placement_verified" && detail.alert === true) {
        placementAlerts.push({
          sequenceId: s.id,
          prospectId: s.prospectId,
          outcome: String(detail.outcome ?? "unknown"),
          detail: String((e.detail as Record<string, unknown> | null)?.url ?? ""),
          ts: e.ts,
        });
      }
    }
  }
  const prospectById = new Map(prospects.map((p) => [p.id, p]));
  replies.sort((a, b) => b.ts.getTime() - a.ts.getTime());

  let pendingDepth3: { id: string; approvers: string[] } | null = null;
  if (campaign.depth === 3 && campaign.status !== "active") {
    const approvals = await authorityApprovals.list(workspace.id, "pending", 20).catch(() => []);
    const match = approvals.find(
      (a) => a.type === "depth3_activation" && (a.bindingJson as { campaignId?: string }).campaignId === campaign.id,
    );
    if (match) pendingDepth3 = { id: match.id, approvers: match.approvers };
  }

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <Link
          href="/dashboard/authority/outreach"
          className="mb-2 inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Outreach
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-stone-900">{campaign.name}</h1>
            <p className="mt-0.5 text-[13px] text-stone-500">
              Depth {campaign.depth} · {domain ? `sending via ${domain.domain}` : "no sending domain"} ·
              cap ≤ {campaign.dailyCap}/day
            </p>
          </div>
          <div className="flex gap-2">
            {chip(campaign.status, campaign.status)}
            {chip(`Depth ${campaign.depth}`, "draft")}
          </div>
        </div>
      </div>

      {/* Placement alerts */}
      {placementAlerts.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-900">
            <TriangleAlert className="h-4 w-4" /> Placement verification alerts ({placementAlerts.length})
          </h2>
          <ul className="space-y-1.5 text-xs text-amber-800">
            {placementAlerts.map((a) => (
              <li key={`${a.sequenceId}-${a.ts.getTime()}`} className="flex items-start gap-2">
                <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>{prospectById.get(a.prospectId)?.domain ?? "unknown site"}</strong> — {a.outcome.replace(/_/g, " ")}
                  <span className="text-amber-600"> · {a.ts.toLocaleDateString()}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Reply inbox */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-800">
          <Inbox className="h-4 w-4" /> Reply inbox ({replies.length})
        </h2>
        {replies.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-center text-xs text-stone-500">
            No replies yet. Any reply stops its sequence and suppresses the sender in the same cycle.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Prospect</th>
                  <th className="px-3 py-2 font-medium">Reply</th>
                  <th className="px-3 py-2 font-medium">Received</th>
                  <th className="px-3 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {replies.map((r) => (
                  <tr key={`${r.sequenceId}-${r.ts.getTime()}`} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium text-stone-900">{prospectById.get(r.prospectId)?.domain ?? "unknown"}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-stone-500">{r.replyId.slice(0, 12)}…</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">{r.ts.toLocaleString()}</td>
                    <td className="px-3 py-2">{chip("auto-suppressed", "draft")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Prospects */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-800">
            <Users className="h-4 w-4" /> Prospects ({prospects.length})
          </h2>
          {canEdit && <DiscoverButton campaignId={campaign.id} />}
        </div>
        {prospects.length === 0 ? (
          <div className="rounded-lg border border-dashed border-stone-300 bg-white p-8 text-center text-sm text-stone-500">
            No prospects yet. Run discovery to find guest-post opportunities and score them.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Site</th>
                  <th className="px-3 py-2 font-medium">Contact</th>
                  <th className="px-3 py-2 font-medium">Quality</th>
                  <th className="px-3 py-2 font-medium">Relevance</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Sequence</th>
                </tr>
              </thead>
              <tbody>
                {prospects.map((p) => {
                  const seq = seqByProspect.get(p.id);
                  const expired = seq ? isDraftExpired(seq.createdAt) && seq.status === "draft" : false;
                  return (
                    <>
                      <tr key={p.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1.5 font-medium text-stone-900">
                            {p.domain}
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-stone-400 hover:text-stone-700"
                              aria-label="Open guidelines"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="text-stone-600">{p.contactName ?? "—"}</span>
                          {p.emailVerified && (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-emerald-700">
                              <BadgeCheck className="h-3 w-3" /> verified
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2"><ScoreCell value={p.qualityScore} /></td>
                        <td className="px-3 py-2"><ScoreCell value={p.relevanceScore} /></td>
                        <td className="px-3 py-2">{chip(p.status, p.status)}</td>
                        <td className="px-3 py-2">
                          {seq ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-stone-600">
                              {SEQ_STATUS_LABEL[seq.status] ?? seq.status}
                              {seq.status === "draft" && !expired && (
                                <span className="inline-flex items-center gap-0.5 text-amber-700">
                                  <Hourglass className="h-3 w-3" />
                                  {Math.max(
                                    0,
                                    DRAFT_EXPIRY_DAYS -
                                      Math.floor((Date.now() - new Date(seq.createdAt).getTime()) / 86_400_000),
                                  )}d left
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </td>
                      </tr>
                      <tr key={`${p.id}-actions`} className="border-b border-stone-100 bg-stone-50/40">
                        <td colSpan={6} className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            {canEdit && p.status === "new" && <QualifyButton prospectId={p.id} />}
                            {seq ? (
                              <>
                                {canEdit && ["draft", "sending"].includes(seq.status) && !expired && campaign.depth !== 1 && (
                                  <SendSequenceButton sequenceId={seq.id} depth={seq.depth} />
                                )}
                                {canEdit && ["contacted", "replied", "placed"].includes(p.status) && (
                                  <VerifyPlacementButton sequenceId={seq.id} />
                                )}
                              </>
                            ) : null}
                            {campaign.depth === 1 && !seq && (
                              <span className="text-[11px] text-stone-400">Depth 1: prospecting only — no drafts or sends.</span>
                            )}
                          </div>
                          {!seq && canEdit && p.status === "qualified" && campaign.depth !== 1 && (
                            <DraftSequenceForm campaignId={campaign.id} prospectId={p.id} depth={campaign.depth} />
                          )}
                        </td>
                      </tr>
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canEdit && campaign.status === "draft" && (
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold text-stone-800">Activation</h2>
          {campaign.depth === 3 ? (
            <Depth3ActivationPanel
              campaignId={campaign.id}
              sendingDomainId={campaign.sendingDomainId}
              pendingApproval={pendingDepth3}
            />
          ) : (
            <ActivateShallowButton campaignId={campaign.id} />
          )}
        </section>
      )}
    </div>
  );
}

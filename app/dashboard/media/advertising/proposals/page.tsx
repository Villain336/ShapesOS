// Marketr — Phase 18 slice 6: spend proposal inbox (polished).
//
// Every launch, pause, budget change, and new flight waits here. Approving
// mints the immutable SpendApproval; execution is impossible without it.
// Server-gated: editor+ only (deciding spend is a money mutation).
//
// Slice 6 polish: status filter, full scope-hash for auditability, and the
// complete lineage chain — proposal → approval → platform receipt ids from
// the AdReport rows behind the spend.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Check, Filter, Inbox as InboxIcon, ShieldCheck, X } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  approveSpendAction,
  rejectSpendAction,
} from "@/lib/adplatforms/gate";
import { onChatGPTProposalApproved } from "@/lib/adplatforms/chatgpt/launch";
import { executeSpendProposal } from "@/lib/adplatforms/execute";
import { prismaApprovalStore, prismaProposalStore } from "@/lib/adplatforms/store";
import AdsTabs from "../_components/AdsTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Spend proposals — Marketr",
  description: "Approve or reject every ad-spend action before it executes.",
};

const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";
const chipSlate = `${chip} bg-stone-100 text-stone-600 border-stone-200`;
const chipAmber = `${chip} bg-amber-50 text-amber-700 border-amber-200`;
const chipGreen = `${chip} bg-emerald-50 text-emerald-700 border-emerald-200`;
const chipRed = `${chip} bg-red-50 text-red-700 border-red-200`;
const chipBrand = `${chip} bg-[var(--brand-50)] text-[var(--brand-700)] border-[var(--brand-600)]/20`;

const STATUSES = ["pending", "approved", "executed", "rejected", "expired"] as const;
type ProposalStatus = (typeof STATUSES)[number];

function statusChip(status: string) {
  switch (status) {
    case "pending":
      return <span className={chipAmber}>Pending</span>;
    case "approved":
      return <span className={chipBrand}>Approved</span>;
    case "executed":
      return <span className={chipGreen}>Executed</span>;
    case "rejected":
      return <span className={chipRed}>Rejected</span>;
    case "expired":
      return <span className={chipSlate}>Expired</span>;
    default:
      return <span className={chipSlate}>{status}</span>;
  }
}

function kindLabel(kind: string) {
  switch (kind) {
    case "launch":
      return "Launch";
    case "pause":
      return "Pause";
    case "budget_change":
      return "Budget change";
    case "new_flight":
      return "New flight";
    default:
      return kind;
  }
}

function money(cents: unknown) {
  if (typeof cents !== "number") return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function payloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "—";
  const p = payload as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof p.channel === "string") bits.push(`channel ${p.channel}`);
  if (typeof p.dailyBudgetCents === "number") bits.push(`daily ${money(p.dailyBudgetCents)}`);
  if (p.budgetCents !== undefined) bits.push(`budget ${money(p.budgetCents)}`);
  if (p.flightStart || p.flightEnd) bits.push(`${p.flightStart ?? "?"} → ${p.flightEnd ?? "?"}`);
  if (typeof p.startDate === "string") bits.push(`${p.startDate}${p.endDate ? ` → ${p.endDate}` : ""}`);
  if (p.campaignName) bits.push(String(p.campaignName));
  if (typeof p.name === "string" && !p.campaignName) bits.push(p.name);
  if (p.inventory && typeof p.inventory === "object") {
    const flags = Object.entries(p.inventory as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/([A-Z])/g, " $1").trim().toLowerCase());
    if (flags.length) bits.push(`inventory: ${flags.join(", ")}`);
  }
  if (p.externalCampaignId) bits.push(String(p.externalCampaignId));
  return bits.length ? bits.join(" · ") : "—";
}

async function decide(proposalId: string, decision: "approve" | "reject") {
  "use server";
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard");
  if (decision === "approve") {
    const { proposal } = await approveSpendAction(prismaProposalStore(), prismaApprovalStore(), proposalId, user.id);
    // Wave 2 ChatGPT Ads: approving a ChatGPT launch proposal moves the
    // campaign proposed → approved so the launch checklist unlocks.
    await onChatGPTProposalApproved({}, proposal);
  } else {
    await rejectSpendAction(prismaProposalStore(), proposalId, user.id);
  }
  revalidatePath("/dashboard/media/advertising/proposals");
}

async function execute(proposalId: string) {
  "use server";
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard");
  await executeSpendProposal(workspace.id, user.id, proposalId);
  revalidatePath("/dashboard/media/advertising/proposals");
}

const EMPTY_COPY: Record<string, { title: string; body: string }> = {
  pending: {
    title: "No pending proposals",
    body: "Nothing is waiting for approval. Proposed launches, pauses, and budget changes will appear here.",
  },
  approved: {
    title: "No approved proposals",
    body: "Approved-but-not-yet-executed proposals will appear here.",
  },
  executed: {
    title: "No executed proposals",
    body: "Once an approved proposal executes against a platform, it lands here with its receipt lineage.",
  },
  rejected: {
    title: "No rejected proposals",
    body: "Rejected proposals are kept for the audit trail — none match this filter yet.",
  },
  expired: {
    title: "No expired proposals",
    body: "Proposals that expired un-acted-upon will appear here.",
  },
  all: {
    title: "No spend proposals yet",
    body: "When you or the agent propose a campaign launch, pause, budget change, or new flight, it waits here for approval.",
  },
};

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canDecide = ["owner", "admin", "editor"].includes(membership.role);

  const params = await searchParams;
  const rawStatus = typeof params.status === "string" ? params.status : "all";
  const statusFilter: ProposalStatus | "all" = (STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as ProposalStatus)
    : "all";

  const proposals = await prisma.spendProposal.findMany({
    where: {
      workspaceId: workspace.id,
      ...(statusFilter === "all" ? {} : { status: statusFilter }),
    },
    orderBy: [{ proposedAt: "desc" }],
    include: { approval: { select: { id: true, approver: true, decidedAt: true, scopeHash: true } } },
    take: 100,
  });

  // Lineage chain: proposal → approval → platform receipt ids from AdReport rows.
  const approvalIds = proposals.map((p) => p.approval?.id).filter((id): id is string => !!id);
  const receipts = approvalIds.length
    ? await prisma.adReport.findMany({
        where: { workspaceId: workspace.id, approvalId: { in: approvalIds }, platformReceiptId: { not: null } },
        select: { approvalId: true, platformReceiptId: true },
        distinct: ["approvalId", "platformReceiptId"],
        take: 500,
      })
    : [];
  const receiptsByApproval = new Map<string, string[]>();
  for (const r of receipts) {
    if (!r.approvalId || !r.platformReceiptId) continue;
    const list = receiptsByApproval.get(r.approvalId) ?? [];
    list.push(r.platformReceiptId);
    receiptsByApproval.set(r.approvalId, list);
  }

  const empty = EMPTY_COPY[statusFilter];

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Spend proposals</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — nothing spends until you approve it here. Approvals are immutable and bound to the exact proposed scope.
        </p>
      </div>

      <AdsTabs active="proposals" />

      <form method="get" className="flex flex-wrap items-center gap-2">
        <select
          name="status"
          defaultValue={statusFilter}
          className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[12px] text-stone-800"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="inline-flex items-center gap-1 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
        >
          <Filter className="h-3.5 w-3.5" />
          Filter
        </button>
      </form>

      {proposals.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white px-6 py-12 text-center">
          <InboxIcon className="h-8 w-8 text-stone-300" />
          <p className="text-[14px] font-medium text-stone-700">{empty.title}</p>
          <p className="max-w-sm text-[13px] text-stone-500">{empty.body}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Scope</th>
                <th className="px-3 py-2 font-medium">Proposed by</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Approval lineage</th>
                <th className="px-3 py-2 font-medium text-right">Decide</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => {
                const rowReceipts = p.approval ? receiptsByApproval.get(p.approval.id) ?? [] : [];
                return (
                  <tr key={p.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-stone-900">{kindLabel(p.kind)}</span>
                      <div className="text-[11px] text-stone-400">{p.targetType} · {p.targetId.slice(0, 12)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-stone-600">{p.targetId}</td>
                    <td className="px-3 py-2.5 text-stone-600">{payloadSummary(p.payload)}</td>
                    <td className="px-3 py-2.5 text-stone-600">{p.proposedBy}</td>
                    <td className="px-3 py-2.5">{statusChip(p.status)}</td>
                    <td className="px-3 py-2.5">
                      {p.approval ? (
                        <div className="flex flex-col gap-0.5 text-[11px] text-stone-500">
                          <span className="inline-flex items-center gap-1 text-stone-700">
                            <ShieldCheck className="h-3 w-3 text-emerald-600" />
                            {p.approval.approver}
                          </span>
                          <span>
                            scope{" "}
                            <code
                              title={`Full scope hash: ${p.approval.scopeHash}`}
                              className="rounded bg-stone-100 px-1 font-mono text-[10px] text-stone-600"
                            >
                              {p.approval.scopeHash.slice(0, 16)}…
                            </code>
                          </span>
                          {rowReceipts.length > 0 ? (
                            <span>
                              receipts{" "}
                              <code
                                title={rowReceipts.join(", ")}
                                className="rounded bg-stone-100 px-1 font-mono text-[10px] text-stone-600"
                              >
                                {rowReceipts[0].slice(0, 18)}
                                {rowReceipts.length > 1 ? ` +${rowReceipts.length - 1}` : ""}
                              </code>
                            </span>
                          ) : (
                            <span className="text-stone-400">no platform receipts yet</span>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col gap-0.5 text-[11px] text-stone-400">
                          <span>No approval yet</span>
                          <span>
                            scope{" "}
                            <code
                              title={`Full scope hash: ${p.scopeHash}`}
                              className="rounded bg-stone-100 px-1 font-mono text-[10px] text-stone-500"
                            >
                              {p.scopeHash.slice(0, 16)}…
                            </code>
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {p.status === "approved" && canDecide ? (
                        <form action={execute.bind(null, p.id)}>
                          <button
                            type="submit"
                            className="inline-flex min-h-[36px] items-center gap-1 rounded-md bg-[var(--brand-600)] px-3 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Execute
                          </button>
                        </form>
                      ) : p.status === "pending" && canDecide ? (
                        <div className="inline-flex gap-1.5">
                          <form action={decide.bind(null, p.id, "approve")}>
                            <button
                              type="submit"
                              className="inline-flex min-h-[36px] items-center gap-1 rounded-md bg-[var(--brand-600)] px-3 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
                            >
                              <Check className="h-3.5 w-3.5" />
                              Approve
                            </button>
                          </form>
                          <form action={decide.bind(null, p.id, "reject")}>
                            <button
                              type="submit"
                              className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-stone-300 px-3 text-[12px] font-medium text-stone-700 hover:bg-stone-50"
                            >
                              <X className="h-3.5 w-3.5" />
                              Reject
                            </button>
                          </form>
                        </div>
                      ) : (
                        <span className="text-[11px] text-stone-400">—</span>
                      )}
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

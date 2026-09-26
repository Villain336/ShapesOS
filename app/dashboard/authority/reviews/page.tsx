// Marketr — R1 Reviews command center.
// Approval queue (positives standard, negatives urgent), reply-state
// tracking (PENDING/APPROVED/REJECTED with poll status), velocity
// dashboard, listing upkeep, and the honest Apple/Bing channel matrix.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { authorityTablesReady } from "@/lib/authority/db";
import { listQueue, listVelocity } from "@/lib/authority/reviews/service";
import { channelCapabilities } from "@/lib/authority/reviews/appleBing";
import { GUARDRAIL_EXPLANATIONS } from "@/lib/authority/reviews/guardrails";
import { ApproveButton, PostButton } from "./_components/ReviewActions";
import {
  MessageSquareText,
  AlertTriangle,
  Clock3,
  CheckCircle2,
  XCircle,
  Gauge,
  Store,
  ShieldCheck,
  Info,
} from "lucide-react";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reviews — Marketr",
  description: "Review-reply approval queue, moderation-state tracking, velocity, and listing upkeep.",
};

const SENTIMENT_CHIP: Record<string, string> = {
  pos: "border-emerald-200 bg-emerald-50 text-emerald-700",
  neu: "border-stone-200 bg-stone-50 text-stone-600",
  neg: "border-red-200 bg-red-50 text-red-700",
};
const STATUS_CHIP: Record<string, string> = {
  pending: "border-stone-200 bg-stone-50 text-stone-600",
  approved: "border-violet-200 bg-violet-50 text-violet-700",
  posted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-red-200 bg-red-50 text-red-700",
  escalated: "border-red-200 bg-red-50 text-red-700",
};
const REPLY_STATE_CHIP: Record<string, string> = {
  none: "border-stone-200 bg-stone-50 text-stone-600",
  pending_mod: "border-amber-200 bg-amber-50 text-amber-700",
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  rejected: "border-red-200 bg-red-50 text-red-700",
};

function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}

function ReplyStateLabel({ state }: { state: string }) {
  if (state === "pending_mod") return "PENDING";
  if (state === "approved") return "APPROVED";
  if (state === "rejected") return "REJECTED";
  return state;
}

export default async function ReviewsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const ready = await authorityTablesReady().catch(() => false);
  let queue: Awaited<ReturnType<typeof listQueue>> = [];
  let velocity: Awaited<ReturnType<typeof listVelocity>> = [];
  if (ready) {
    [queue, velocity] = await Promise.all([
      listQueue(workspace.id, { limit: 100 }).catch(() => []),
      listVelocity(workspace.id).catch(() => []),
    ]);
  }

  const pending = queue.filter((q) => q.status === "pending");
  const urgent = pending.filter((q) => q.sentiment === "neg");
  const standard = pending.filter((q) => q.sentiment !== "neg");
  const posted = queue.filter((q) => q.status === "posted");
  const capabilities = channelCapabilities();

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Reviews</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
            AI-drafted GBP replies in an approval queue — v1 is drafts-only, nothing posts
            without a two-person approved review_reply_post. Google moderates every reply
            pre-publication; the queue tracks PENDING → APPROVED / REJECTED via polling.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600">
            <ShieldCheck className="h-3 w-3" /> v1: drafts only
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600">
            <Clock3 className="h-3 w-3" /> {pending.length} awaiting approval
          </span>
        </div>
      </div>

      {!ready && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Authority tables are not provisioned yet — run the Phase 6 authority migration. This
          page renders empty until then.
        </div>
      )}

      {/* Urgent (negatives) */}
      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            <AlertTriangle className="h-4 w-4 text-red-500" /> Urgent — negatives first
          </h2>
          <span className="text-xs text-stone-500">{urgent.length} pending</span>
        </div>
        {urgent.length === 0 ? (
          <p className="text-sm text-stone-500">No negative reviews awaiting a reply.</p>
        ) : (
          <QueueTable rows={urgent} />
        )}
      </section>

      {/* Standard queue (positives/neutrals) */}
      <section className="rounded-xl border border-stone-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            <MessageSquareText className="h-4 w-4 text-stone-400" /> Approval queue — standard
          </h2>
          <span className="text-xs text-stone-500">{standard.length} pending</span>
        </div>
        {standard.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing in the standard queue.</p>
        ) : (
          <QueueTable rows={standard} />
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Reply-state tracking */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <CheckCircle2 className="h-4 w-4 text-stone-400" /> Reply-state tracking
            </h2>
            <span className="text-xs text-stone-500">polled, never assumed</span>
          </div>
          {posted.length === 0 ? (
            <p className="text-sm text-stone-500">No posted replies yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-stone-200">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Reviewer</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Rejections</th>
                  </tr>
                </thead>
                <tbody>
                  {posted.slice(0, 8).map((q) => (
                    <tr key={q.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-medium text-stone-900">
                        {q.reviewerName ?? "Reviewer"}
                        <span className="ml-1.5 text-amber-500">{"★".repeat(Math.min(5, q.rating))}</span>
                      </td>
                      <td className="px-3 py-2">{chip(<ReplyStateLabel state={q.replyState} />, REPLY_STATE_CHIP[q.replyState] ?? REPLY_STATE_CHIP.none)}</td>
                      <td className="px-3 py-2 text-[12px] text-stone-600">
                        {q.rejectionCount > 0 ? `${q.rejectionCount} rejection${q.rejectionCount > 1 ? "s" : ""}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Velocity dashboard */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <Gauge className="h-4 w-4 text-stone-400" /> Velocity dashboard
            </h2>
            <span className="text-xs text-stone-500">Google&apos;s four channels only</span>
          </div>
          {velocity.length === 0 ? (
            <p className="text-sm text-stone-500">
              No velocity data yet. Trigger requests via POST /api/authority/reviews/velocity/trigger
              from CRM/POS webhooks — channels: receipt, thank-you email, end-of-chat, in-store QR.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-stone-200">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Location</th>
                    <th className="px-3 py-2 font-medium">7d velocity</th>
                    <th className="px-3 py-2 font-medium">30d velocity</th>
                    <th className="px-3 py-2 font-medium">Requests</th>
                    <th className="px-3 py-2 font-medium">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {velocity.slice(0, 8).map((v) => (
                    <tr key={v.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-medium text-stone-900">{v.locationRef}</td>
                      <td className="px-3 py-2 text-stone-600">{v.velocity7d.toFixed(1)}/day</td>
                      <td className="px-3 py-2 text-stone-600">{v.velocity30d.toFixed(1)}/day</td>
                      <td className="px-3 py-2 text-stone-600">{v.requestsSent}</td>
                      <td className="px-3 py-2 text-stone-600">{v.reviewsReceived}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Listing upkeep */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <Store className="h-4 w-4 text-stone-400" /> Listing upkeep
            </h2>
            <span className="text-xs text-stone-500">approval-bound listing edits</span>
          </div>
          <p className="text-sm text-stone-500">
            Hours, attributes, categories, photo uploads, and local posts (including recurring
            offers/events) sync through the GBP API under the 10-edits/min per-profile cap.
            Customer review-media feeds the brand-intelligence surface. Edits are
            listing_edit-approval-bound at the API layer.
          </p>
        </section>

        {/* Apple / Bing honesty matrix */}
        <section className="rounded-xl border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <Info className="h-4 w-4 text-stone-400" /> Channel honesty
            </h2>
            <span className="text-xs text-stone-500">true tier labels</span>
          </div>
          <div className="overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Replies</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(capabilities).map(([channel, c]) => (
                  <tr key={channel} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium capitalize text-stone-900">{channel}</td>
                    <td className="px-3 py-2">{chip(c.tier, "border-stone-200 bg-stone-50 text-stone-600")}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">{c.reviewReplies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function QueueTable({ rows }: { rows: Awaited<ReturnType<typeof listQueue>> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-medium">Reviewer</th>
            <th className="px-3 py-2 font-medium">Review</th>
            <th className="px-3 py-2 font-medium">Sentiment</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((q) => (
            <>
              <tr key={q.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                <td className="px-3 py-2">
                  <span className="font-medium text-stone-900">
                    {q.reviewerName ?? "Anonymous"}
                    <span className="ml-1.5 text-amber-500">{"★".repeat(Math.min(5, q.rating))}</span>
                  </span>
                  <span className="block text-[11px] text-stone-500">{q.locationRef}</span>
                </td>
                <td className="max-w-xs px-3 py-2">
                  {q.reviewText && <p className="line-clamp-2 text-[12px] text-stone-600">{q.reviewText}</p>}
                  {q.guardrailFlags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {q.guardrailFlags.map((f) => (
                        <span
                          key={f}
                          title={GUARDRAIL_EXPLANATIONS[f] ?? f}
                          className="inline-flex items-center gap-1 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
                        >
                          <XCircle className="h-3 w-3" /> {f}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">{chip(q.sentiment, SENTIMENT_CHIP[q.sentiment] ?? SENTIMENT_CHIP.neu)}</td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1">
                    {chip(q.status, STATUS_CHIP[q.status] ?? STATUS_CHIP.pending)}
                    {q.status === "posted" && chip(<ReplyStateLabel state={q.replyState} />, REPLY_STATE_CHIP[q.replyState] ?? REPLY_STATE_CHIP.none)}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="flex gap-1.5">
                    <ApproveButton id={q.id} draftReply={q.draftReply} />
                    {q.status === "approved" && <PostButton id={q.id} />}
                  </span>
                </td>
              </tr>
              <tr key={`${q.id}-draft`} className="border-b border-stone-100 bg-stone-50/40">
                <td colSpan={5} className="px-3 py-2">
                  {q.draftReply ? (
                    <p className="rounded-md bg-stone-50 p-2 text-[13px] italic text-stone-700">
                      Draft: {q.draftReply}
                    </p>
                  ) : (
                    <p className="text-[13px] text-red-600">
                      Draft blocked by guardrails — write the reply manually, then approve.
                    </p>
                  )}
                </td>
              </tr>
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}


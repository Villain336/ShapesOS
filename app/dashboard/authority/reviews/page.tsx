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
  title: "Reviews — ShapesOS",
  description: "Review-reply approval queue, moderation-state tracking, velocity, and listing upkeep.",
};

// Sentiment is analytic, never status-colored — neutral chips.
const SENTIMENT_CHIP: Record<string, string> = {
  pos: "border-line bg-paper text-muted shadow-control",
  neu: "border-line bg-paper text-muted shadow-control",
  neg: "border-line bg-paper text-muted shadow-control",
};
// Review-reply workflow states: pending needs review, approved/posted are
// done, rejected/escalated are failed.
const STATUS_CHIP: Record<string, string> = {
  pending: "bg-needs text-ink",
  approved: "bg-done text-white",
  posted: "bg-done text-white",
  rejected: "bg-failed text-white",
  escalated: "bg-failed text-white",
};
const REPLY_STATE_CHIP: Record<string, string> = {
  none: "border-line bg-paper text-muted shadow-control",
  pending_mod: "bg-needs text-ink",
  approved: "bg-done text-white",
  rejected: "bg-failed text-white",
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
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Reviews</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            AI-drafted GBP replies in an approval queue — v1 is drafts-only, nothing posts
            without a two-person approved review_reply_post. Google moderates every reply
            pre-publication; the queue tracks PENDING → APPROVED / REJECTED via polling.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] font-medium text-muted">
            <ShieldCheck className="h-3 w-3" /> v1: drafts only
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-[11px] font-medium text-muted">
            <Clock3 className="h-3 w-3" /> {pending.length} awaiting approval
          </span>
        </div>
      </div>

      {!ready && (
        <div className="rounded-lg border border-needs bg-needs-tint p-4 text-sm text-ink">
          Authority tables are not provisioned yet — run the Phase 6 authority migration. This
          page renders empty until then.
        </div>
      )}

      {/* Urgent (negatives) */}
      <section className="rounded-lg border border-line bg-paper p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <AlertTriangle className="h-4 w-4 text-failed-text" /> Urgent — negatives first
          </h2>
          <span className="text-xs text-muted">{urgent.length} pending</span>
        </div>
        {urgent.length === 0 ? (
          <p className="text-sm text-muted">No negative reviews awaiting a reply.</p>
        ) : (
          <QueueTable rows={urgent} />
        )}
      </section>

      {/* Standard queue (positives/neutrals) */}
      <section className="rounded-lg border border-line bg-paper p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <MessageSquareText className="h-4 w-4 text-subtle" /> Approval queue — standard
          </h2>
          <span className="text-xs text-muted">{standard.length} pending</span>
        </div>
        {standard.length === 0 ? (
          <p className="text-sm text-muted">Nothing in the standard queue.</p>
        ) : (
          <QueueTable rows={standard} />
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Reply-state tracking */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <CheckCircle2 className="h-4 w-4 text-subtle" /> Reply-state tracking
            </h2>
            <span className="text-xs text-muted">polled, never assumed</span>
          </div>
          {posted.length === 0 ? (
            <p className="text-sm text-muted">No posted replies yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Reviewer</th>
                    <th className="px-3 py-2 font-medium">State</th>
                    <th className="px-3 py-2 font-medium">Rejections</th>
                  </tr>
                </thead>
                <tbody>
                  {posted.slice(0, 8).map((q) => (
                    <tr key={q.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2 font-medium text-ink">
                        {q.reviewerName ?? "Reviewer"}
                        <span className="ml-1.5 text-ink">{"★".repeat(Math.min(5, q.rating))}</span>
                      </td>
                      <td className="px-3 py-2">{chip(<ReplyStateLabel state={q.replyState} />, REPLY_STATE_CHIP[q.replyState] ?? REPLY_STATE_CHIP.none)}</td>
                      <td className="px-3 py-2 text-[12px] text-muted">
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
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Gauge className="h-4 w-4 text-subtle" /> Velocity dashboard
            </h2>
            <span className="text-xs text-muted">Google&apos;s four channels only</span>
          </div>
          {velocity.length === 0 ? (
            <p className="text-sm text-muted">
              No velocity data yet. Trigger requests via POST /api/authority/reviews/velocity/trigger
              from CRM/POS webhooks — channels: receipt, thank-you email, end-of-chat, in-store QR.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                    <th className="px-3 py-2 font-medium">Location</th>
                    <th className="px-3 py-2 font-medium">7d velocity</th>
                    <th className="px-3 py-2 font-medium">30d velocity</th>
                    <th className="px-3 py-2 font-medium">Requests</th>
                    <th className="px-3 py-2 font-medium">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {velocity.slice(0, 8).map((v) => (
                    <tr key={v.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2 font-medium text-ink">{v.locationRef}</td>
                      <td className="px-3 py-2 text-muted">{v.velocity7d.toFixed(1)}/day</td>
                      <td className="px-3 py-2 text-muted">{v.velocity30d.toFixed(1)}/day</td>
                      <td className="px-3 py-2 text-muted">{v.requestsSent}</td>
                      <td className="px-3 py-2 text-muted">{v.reviewsReceived}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Listing upkeep */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Store className="h-4 w-4 text-subtle" /> Listing upkeep
            </h2>
            <span className="text-xs text-muted">approval-bound listing edits</span>
          </div>
          <p className="text-sm text-muted">
            Hours, attributes, categories, photo uploads, and local posts (including recurring
            offers/events) sync through the GBP API under the 10-edits/min per-profile cap.
            Customer review-media feeds the brand-intelligence surface. Edits are
            listing_edit-approval-bound at the API layer.
          </p>
        </section>

        {/* Apple / Bing honesty matrix */}
        <section className="rounded-lg border border-line bg-paper p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Info className="h-4 w-4 text-subtle" /> Channel honesty
            </h2>
            <span className="text-xs text-muted">true tier labels</span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Replies</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(capabilities).map(([channel, c]) => (
                  <tr key={channel} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium capitalize text-ink">{channel}</td>
                    <td className="px-3 py-2">{chip(c.tier, "border-line bg-paper text-muted")}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">{c.reviewReplies}</td>
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
    <div className="overflow-x-auto rounded-lg border border-line bg-paper">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line bg-paper/60 text-[11px] text-muted">
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
              <tr key={q.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-3 py-2">
                  <span className="font-medium text-ink">
                    {q.reviewerName ?? "Anonymous"}
                    <span className="ml-1.5 text-ink">{"★".repeat(Math.min(5, q.rating))}</span>
                  </span>
                  <span className="block text-[11px] text-muted">{q.locationRef}</span>
                </td>
                <td className="max-w-xs px-3 py-2">
                  {q.reviewText && <p className="line-clamp-2 text-[12px] text-muted">{q.reviewText}</p>}
                  {q.guardrailFlags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {q.guardrailFlags.map((f) => (
                        <span
                          key={f}
                          title={GUARDRAIL_EXPLANATIONS[f] ?? f}
                          className="inline-flex items-center gap-1 rounded-full bg-failed-tint px-1.5 py-0.5 text-[10px] font-medium text-failed-text"
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
              <tr key={`${q.id}-draft`} className="border-b border-line bg-paper/40">
                <td colSpan={5} className="px-3 py-2">
                  {q.draftReply ? (
                    <p className="rounded-md bg-paper p-2 text-[13px] italic text-muted">
                      Draft: {q.draftReply}
                    </p>
                  ) : (
                    <p className="text-[13px] text-failed-text">
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


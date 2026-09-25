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
import { Badge } from "@/components/vault/shadcn/badge";
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

const SENTIMENT_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pos: "default",
  neu: "secondary",
  neg: "destructive",
};
const STATUS_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  approved: "secondary",
  posted: "default",
  rejected: "destructive",
  escalated: "destructive",
};
const REPLY_STATE_BADGE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  none: "outline",
  pending_mod: "secondary",
  approved: "default",
  rejected: "destructive",
};

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
    <div className="flex h-full flex-col gap-6 bg-[#FAFAF7] p-4 md:p-6">
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
          <Badge variant="outline">
            <ShieldCheck className="mr-1 h-3 w-3" /> v1: drafts only
          </Badge>
          <Badge variant="secondary">
            <Clock3 className="mr-1 h-3 w-3" /> {pending.length} awaiting approval
          </Badge>
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
          <ul className="space-y-2">{urgent.map((q) => <QueueRow key={q.id} q={q} />)}</ul>
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
          <ul className="space-y-2">{standard.map((q) => <QueueRow key={q.id} q={q} />)}</ul>
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
            <ul className="space-y-1.5">
              {posted.slice(0, 8).map((q) => (
                <li
                  key={q.id}
                  className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm"
                >
                  <span className="truncate text-stone-800">
                    {q.reviewerName ?? "Reviewer"} · {"★".repeat(Math.min(5, q.rating))}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Badge variant={REPLY_STATE_BADGE[q.replyState] ?? "outline"}>
                      {q.replyState === "pending_mod"
                        ? "PENDING"
                        : q.replyState === "approved"
                          ? "APPROVED"
                          : q.replyState === "rejected"
                            ? "REJECTED"
                            : "none"}
                    </Badge>
                    {q.rejectionCount > 0 && (
                      <span className="text-[11px] text-stone-500">
                        {q.rejectionCount} rejection{q.rejectionCount > 1 ? "s" : ""}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
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
            <ul className="space-y-1.5">
              {velocity.slice(0, 8).map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between rounded-lg border border-stone-100 px-3 py-2 text-sm"
                >
                  <span className="font-medium text-stone-800">{v.locationRef}</span>
                  <span className="text-xs text-stone-500">
                    {v.velocity7d.toFixed(1)}/day (7d) · {v.velocity30d.toFixed(1)}/day (30d) ·{" "}
                    {v.requestsSent} sent / {v.reviewsReceived} received
                  </span>
                </li>
              ))}
            </ul>
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
          <ul className="space-y-2">
            {Object.entries(capabilities).map(([channel, c]) => (
              <li key={channel} className="rounded-lg border border-stone-100 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize text-stone-900">{channel}</span>
                  <Badge variant="outline">{c.tier}</Badge>
                </div>
                <p className="mt-1 text-xs text-stone-500">Replies: {c.reviewReplies}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function QueueRow({ q }: { q: Awaited<ReturnType<typeof listQueue>>[number] }) {
  return (
    <li className="rounded-lg border border-stone-100 p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-stone-900">
          {q.reviewerName ?? "Anonymous"} · {"★".repeat(Math.min(5, q.rating))}
          <span className="ml-2 text-xs font-normal text-stone-500">{q.locationRef}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Badge variant={SENTIMENT_BADGE[q.sentiment] ?? "secondary"}>{q.sentiment}</Badge>
          <Badge variant={STATUS_BADGE[q.status] ?? "outline"}>{q.status}</Badge>
          {q.status === "posted" && (
            <Badge variant={REPLY_STATE_BADGE[q.replyState] ?? "outline"}>
              {q.replyState === "pending_mod" ? "PENDING" : q.replyState}
            </Badge>
          )}
        </span>
      </div>
      {q.reviewText && <p className="mt-1 text-[13px] text-stone-600 line-clamp-2">{q.reviewText}</p>}
      {q.guardrailFlags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {q.guardrailFlags.map((f) => (
            <span
              key={f}
              title={GUARDRAIL_EXPLANATIONS[f] ?? f}
              className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700"
            >
              <XCircle className="h-3 w-3" /> {f}
            </span>
          ))}
        </div>
      )}
      {q.draftReply ? (
        <p className="mt-1.5 rounded-md bg-stone-50 p-2 text-[13px] italic text-stone-700">
          Draft: {q.draftReply}
        </p>
      ) : (
        <p className="mt-1.5 text-[13px] text-red-600">
          Draft blocked by guardrails — write the reply manually, then approve.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <ApproveButton id={q.id} draftReply={q.draftReply} />
        {q.status === "approved" && <PostButton id={q.id} />}
      </div>
    </li>
  );
}


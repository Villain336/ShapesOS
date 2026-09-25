// Marketr — R1 prisma-backed service (routes layer).
//
// Pure logic lives in ./intake, ./guardrails, ./drafts, ./queue,
// ./replyState, ./upkeep, ./velocity, ./appleBing (with memory twins for
// batteries). This module is the thin prisma persistence for the API routes.
// All queries are workspace-scoped.

import { prisma } from "@/lib/prisma";
import type {
  ReviewQueueStatus,
  ReviewReplyState,
  ReviewSentiment,
  ReviewSource,
} from "@prisma/client";
import { createId } from "@/lib/media/ids";
import { REVIEW_REQUEST_CHANNELS, type IntakeResult, type ReviewRequestChannel } from "./types";
import { validateTrigger } from "./velocity";

export interface QueueFilters {
  status?: ReviewQueueStatus;
  sentiment?: ReviewSentiment;
  limit?: number;
}

export async function upsertQueueItem(args: {
  workspaceId: string;
  intake: IntakeResult;
  reviewText: string | null;
  reviewerName: string | null;
}) {
  const { workspaceId, intake, reviewText, reviewerName } = args;
  const data = {
    id: createId(),
    workspaceId,
    locationRef: intake.locationRef,
    reviewId: intake.reviewId,
    source: intake.source as ReviewSource,
    rating: intake.rating,
    sentiment: intake.sentiment,
    reviewText,
    reviewerName,
    draftReply: intake.draftReply,
    guardrailFlags: intake.guardrailFlags,
    status: "pending" as ReviewQueueStatus,
    replyState: "none" as ReviewReplyState,
    rejectionCount: 0,
  };
  // Idempotent: the unique (workspaceId, source, reviewId) constraint wins.
  try {
    return await prisma.reviewQueue.create({ data });
  } catch {
    const existing = await prisma.reviewQueue.findFirst({
      where: { workspaceId, source: intake.source as ReviewSource, reviewId: intake.reviewId },
    });
    if (!existing) throw new Error("Queue insert failed.");
    return existing;
  }
}

export async function getQueueItem(id: string, workspaceId: string) {
  return prisma.reviewQueue.findFirst({ where: { id, workspaceId } });
}

/** Find a queue item by its platform review identity (dedup helper). */
export async function getQueueItemByReview(workspaceId: string, source: ReviewSource, reviewId: string) {
  return prisma.reviewQueue.findFirst({ where: { workspaceId, source, reviewId } });
}

export async function listQueue(workspaceId: string, filters: QueueFilters = {}) {
  const rows = await prisma.reviewQueue.findMany({
    where: {
      workspaceId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.sentiment ? { sentiment: filters.sentiment } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(200, Math.max(1, filters.limit ?? 100)),
  });
  // Urgent (negatives) first.
  return rows.sort((a, b) => {
    if (a.sentiment === "neg" && b.sentiment !== "neg") return -1;
    if (b.sentiment === "neg" && a.sentiment !== "neg") return 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

/** Find the review_reply_post approval bound to a queue item. */
export async function approvalForQueueItem(workspaceId: string, queueItemId: string) {
  const approvals = await prisma.authorityApproval.findMany({
    where: { workspaceId, type: "review_reply_post" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return (
    approvals.find((a) => {
      const b = a.bindingJson as Record<string, unknown> | null;
      return b && b.kind === "review_reply_post" && b.reviewQueueId === queueItemId;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Velocity (prisma ReviewVelocity + funnelJson daily buckets).
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface FunnelJson {
  triage?: { satisfiedToGoogle: number; unhappyToPrivateFeedback: number };
  byChannel?: Partial<Record<ReviewRequestChannel, number>>;
  daily?: Record<string, { sent: number; received: number }>;
}

function ensureFunnel(raw: unknown): Required<FunnelJson> {
  const f = (raw ?? {}) as FunnelJson;
  return {
    triage: f.triage ?? { satisfiedToGoogle: 0, unhappyToPrivateFeedback: 0 },
    byChannel: { receipt: 0, thank_you_email: 0, end_of_chat: 0, in_store_qr: 0, ...(f.byChannel ?? {}) },
    daily: f.daily ?? {},
  };
}

function velocities(daily: Record<string, { sent: number; received: number }>): { velocity7d: number; velocity30d: number } {
  const now = Date.now();
  let recv7 = 0;
  let recv30 = 0;
  for (const [date, bucket] of Object.entries(daily)) {
    const ageDays = (now - new Date(`${date}T00:00:00Z`).getTime()) / 86400000;
    if (ageDays < 7) recv7 += bucket.received;
    if (ageDays < 30) recv30 += bucket.received;
  }
  return { velocity7d: recv7 / 7, velocity30d: recv30 / 30 };
}

export async function recordVelocityTrigger(args: {
  workspaceId: string;
  locationRef: string;
  channel: string;
  customerRef: string;
}) {
  validateTrigger({
    locationRef: args.locationRef,
    channel: args.channel as ReviewRequestChannel,
    customerRef: args.customerRef,
  });
  const channel = args.channel as ReviewRequestChannel;
  const existing = await prisma.reviewVelocity.findFirst({
    where: { workspaceId: args.workspaceId, locationRef: args.locationRef },
  });
  const funnel = ensureFunnel(existing?.funnelJson);
  const today = todayIso();
  const bucket = funnel.daily[today] ?? { sent: 0, received: 0 };
  bucket.sent += 1;
  funnel.daily[today] = bucket;
  funnel.byChannel[channel] = (funnel.byChannel[channel] ?? 0) + 1;
  const { velocity7d, velocity30d } = velocities(funnel.daily);
  const row = existing
    ? await prisma.reviewVelocity.update({
        where: { id: existing.id },
        data: {
          requestsSent: existing.requestsSent + 1,
          velocity7d,
          velocity30d,
          funnelJson: funnel as never,
        },
      })
    : await prisma.reviewVelocity.create({
        data: {
          id: createId(),
          workspaceId: args.workspaceId,
          locationRef: args.locationRef,
          requestsSent: 1,
          reviewsReceived: 0,
          velocity7d: 0,
          velocity30d: 0,
          funnelJson: funnel as never,
        },
      });
  return row;
}

/** A received review (from the webhook intake) bumps reviewsReceived + daily received. */
export async function recordVelocityReceived(workspaceId: string, locationRef: string) {
  const existing = await prisma.reviewVelocity.findFirst({ where: { workspaceId, locationRef } });
  const funnel = ensureFunnel(existing?.funnelJson);
  const today = todayIso();
  const bucket = funnel.daily[today] ?? { sent: 0, received: 0 };
  bucket.received += 1;
  funnel.daily[today] = bucket;
  const { velocity7d, velocity30d } = velocities(funnel.daily);
  if (existing) {
    return prisma.reviewVelocity.update({
      where: { id: existing.id },
      data: { reviewsReceived: existing.reviewsReceived + 1, velocity7d, velocity30d, funnelJson: funnel as never },
    });
  }
  return prisma.reviewVelocity.create({
    data: {
      id: createId(),
      workspaceId,
      locationRef,
      requestsSent: 0,
      reviewsReceived: 1,
      velocity7d,
      velocity30d,
      funnelJson: funnel as never,
    },
  });
}

export async function listVelocity(workspaceId: string) {
  return prisma.reviewVelocity.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, take: 100 });
}

/** Reject anything outside the four documented channels at the schema level too. */
export const reviewRequestChannelSchema = REVIEW_REQUEST_CHANNELS;

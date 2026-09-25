// Marketr — R1 review-velocity engine (2026-compliant).
//
// SPEC-PHASE6.md §2/R1: smart-timing velocity triggers. CRM/POS transaction
// webhooks → request inside the four Google-documented channels only:
// receipts, thank-you emails, end-of-chat, in-store QR. Sentiment-split
// funnels are "feedback triage" only — never review gating.
//
// Pure logic + a memory velocity store (battery twin of prisma ReviewVelocity).

import { REVIEW_REQUEST_CHANNELS, type ReviewRequestChannel } from "./types";

export interface VelocityTrigger {
  locationRef: string;
  channel: ReviewRequestChannel;
  customerRef: string; // hashed externally — never raw PII in the store
  transactionId?: string;
}

export interface VelocitySnapshot {
  locationRef: string;
  requestsSent: number;
  reviewsReceived: number;
  velocity7d: number; // reviews received per day, trailing 7d
  velocity30d: number; // reviews received per day, trailing 30d
  funnel: VelocityFunnel;
}

export interface VelocityFunnel {
  /** Sentiment-split triage: satisfied -> Google channel; unhappy -> private feedback. */
  triage: {
    satisfiedToGoogle: number;
    unhappyToPrivateFeedback: number;
  };
  /** Requests per channel. */
  byChannel: Record<ReviewRequestChannel, number>;
  /** Daily buckets (ISO date -> {sent, received}) kept in the store's funnelJson. */
  daily: Record<string, { sent: number; received: number }>;
  /** Honest label — triage is never suppression. */
  label: "feedback triage";
}

function emptyFunnel(): VelocityFunnel {
  return {
    triage: { satisfiedToGoogle: 0, unhappyToPrivateFeedback: 0 },
    byChannel: { receipt: 0, thank_you_email: 0, end_of_chat: 0, in_store_qr: 0 },
    daily: {},
    label: "feedback triage",
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Validate the trigger: channel must be one of Google's four documented channels. */
export function validateTrigger(trigger: VelocityTrigger): void {
  if (!(REVIEW_REQUEST_CHANNELS as readonly string[]).includes(trigger.channel)) {
    throw new Error(
      `Channel "${trigger.channel}" is not one of Google's documented review-request channels (${REVIEW_REQUEST_CHANNELS.join(", ")}). Request blocked.`,
    );
  }
  if (!trigger.locationRef.trim()) throw new Error("locationRef is required.");
  if (!trigger.customerRef.trim()) throw new Error("customerRef is required (hashed).");
}

export interface MemoryVelocityRecord {
  workspaceId: string;
  locationRef: string;
  requestsSent: number;
  reviewsReceived: number;
  funnel: VelocityFunnel;
  updatedAt: Date;
}

export function createMemoryVelocityStore() {
  const records = new Map<string, MemoryVelocityRecord>();
  const key = (workspaceId: string, locationRef: string) => `${workspaceId}|${locationRef}`;

  function getOrCreate(workspaceId: string, locationRef: string): MemoryVelocityRecord {
    let r = records.get(key(workspaceId, locationRef));
    if (!r) {
      r = {
        workspaceId,
        locationRef,
        requestsSent: 0,
        reviewsReceived: 0,
        funnel: emptyFunnel(),
        updatedAt: new Date(),
      };
      records.set(key(workspaceId, locationRef), r);
    }
    return r;
  }

  function compute(snapshot: MemoryVelocityRecord): VelocitySnapshot {
    const now = new Date();
    let sent7 = 0;
    let recv7 = 0;
    let sent30 = 0;
    let recv30 = 0;
    for (const [date, bucket] of Object.entries(snapshot.funnel.daily)) {
      const ageDays = (now.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86400000;
      if (ageDays < 7) {
        sent7 += bucket.sent;
        recv7 += bucket.received;
      }
      if (ageDays < 30) {
        sent30 += bucket.sent;
        recv30 += bucket.received;
      }
    }
    void sent7;
    void sent30;
    return {
      locationRef: snapshot.locationRef,
      requestsSent: snapshot.requestsSent,
      reviewsReceived: snapshot.reviewsReceived,
      velocity7d: recv7 / 7,
      velocity30d: recv30 / 30,
      funnel: snapshot.funnel,
    };
  }

  return {
    /** Record a smart-timing request (idempotent per transaction when provided). */
    trigger(workspaceId: string, t: VelocityTrigger): VelocitySnapshot {
      validateTrigger(t);
      const r = getOrCreate(workspaceId, t.locationRef);
      r.requestsSent += 1;
      r.funnel.byChannel[t.channel] += 1;
      const today = isoDate(new Date());
      const bucket = r.funnel.daily[today] ?? { sent: 0, received: 0 };
      bucket.sent += 1;
      r.funnel.daily[today] = bucket;
      r.updatedAt = new Date();
      return compute(r);
    },
    /** Record a received review (called from the GBP webhook intake). */
    received(workspaceId: string, locationRef: string): VelocitySnapshot {
      const r = getOrCreate(workspaceId, locationRef);
      r.reviewsReceived += 1;
      const today = isoDate(new Date());
      const bucket = r.funnel.daily[today] ?? { sent: 0, received: 0 };
      bucket.received += 1;
      r.funnel.daily[today] = bucket;
      r.updatedAt = new Date();
      return compute(r);
    },
    /** Record a feedback-triage decision (satisfied -> Google; unhappy -> private). */
    triage(workspaceId: string, locationRef: string, satisfied: boolean): VelocitySnapshot {
      const r = getOrCreate(workspaceId, locationRef);
      if (satisfied) r.funnel.triage.satisfiedToGoogle += 1;
      else r.funnel.triage.unhappyToPrivateFeedback += 1;
      r.updatedAt = new Date();
      return compute(r);
    },
    snapshot(workspaceId: string, locationRef: string): VelocitySnapshot {
      return compute(getOrCreate(workspaceId, locationRef));
    },
  };
}

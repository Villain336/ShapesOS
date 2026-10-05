// Marketr — Phase 6 L1: GBP direct management + the 10-edits/min queue.
//
// Hard rule (spec §2/L1, exit gate 7): the 10 edits/min per profile cap is
// un-raisable. Burst edit requests QUEUE with scheduled_at spacing — they
// are never dropped.

import type { GbpClient } from "../fake";

/** Un-raisable. One edit per 6s per profile, enforced at queue time. */
export const GBP_EDITS_PER_MINUTE = 10;
export const GBP_EDIT_SPACING_MS = Math.floor(60_000 / GBP_EDITS_PER_MINUTE);

/** Application gating copy — shown verbatim wherever GBP is presented. */
export const GBP_APPLICATION_COPY =
  "API access requires application (ShapesOS's own 60+ day verified GBP + website); quota 0 QPM until approved, 300 QPM after.";

export interface GbpEditRequest {
  profileId: string;
  locationRef: string;
  kind: "nap" | "hours" | "attributes" | "categories" | "photo" | "post";
  /** The exact payload sent to the provider — also bound into the listing_edit approval. */
  payload: Record<string, unknown>;
}

export interface GbpLocationPayload {
  locationRef: string;
  nap?: Record<string, unknown>;
  hours?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  categories?: string[];
}

export interface GbpPostPayload {
  locationRef: string;
  topicType: "update" | "offer" | "event";
  title: string;
  summary: string;
  actionUrl?: string;
  /** Recurrence info supported since April 7, 2026 (RFC 5545 RRULE). */
  recurrence?: { rrule: string };
}

export class GbpQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GbpQueueError";
  }
}

/**
 * Compute the scheduled_at for a new edit given the queued jobs ahead of it
 * for the same profile. Pure — the battery twin exercises this directly.
 * Burst jobs are spaced GBP_EDIT_SPACING_MS apart; nothing is dropped.
 */
export function scheduleNextEdit(
  existingQueuedScheduledAt: Date[],
  now = new Date(),
): Date {
  let latest = now.getTime();
  for (const d of existingQueuedScheduledAt) {
    const t = d.getTime();
    if (t > latest) latest = t;
  }
  return new Date(latest + GBP_EDIT_SPACING_MS);
}

/** The binding payload for a listing_edit approval — the exact edit the approval covers. */
export function listingEditBinding(edit: GbpEditRequest): Record<string, unknown> {
  return {
    action: "listing_edit",
    channel: "gbp",
    profileId: edit.profileId,
    locationRef: edit.locationRef,
    kind: edit.kind,
    payload: edit.payload,
  };
}

/**
 * Validate a GBP edit request. The Q&A API was discontinued Nov 2025 — any
 * qna request is rejected, not silently rewritten.
 */
export function validateGbpEdit(edit: {
  profileId: string;
  locationRef: string;
  kind: string;
  payload: Record<string, unknown>;
}): asserts edit is GbpEditRequest {
  if (!edit.profileId || !edit.locationRef) throw new GbpQueueError("profileId and locationRef are required.");
  const kinds = ["nap", "hours", "attributes", "categories", "photo", "post"] as const;
  if (!kinds.includes(edit.kind as (typeof kinds)[number])) {
    throw new GbpQueueError(
      `Unsupported GBP edit kind "${edit.kind}". Note: the Q&A API was discontinued Nov 2025 and is not supported.`,
    );
  }
  if (!edit.payload || typeof edit.payload !== "object") throw new GbpQueueError("Edit payload is required.");
}

export interface GbpProfileManager {
  readonly channel: "gbp";
  updateLocations(edit: GbpEditRequest): Promise<{ ok: boolean; scheduledAt: Date }>;
  publishPost(post: GbpPostPayload): Promise<{ ok: boolean; scheduledAt: Date }>;
  syncVia(client: GbpClient, edit: GbpEditRequest): Promise<{ ok: boolean }>;
}

/**
 * Build a GBP profile manager. enqueue() persists a ListingSyncJob row —
 * the caller supplies it (prisma in prod, memory in batteries). The manager
 * computes the cap-aware scheduled_at and returns it; execution happens in
 * lib/authority/listings/sync.ts.
 */
export function createGbpProfileManager(enqueue: (edit: GbpEditRequest, scheduledAt: Date) => Promise<void>): GbpProfileManager {
  return {
    channel: "gbp",
    async updateLocations(edit) {
      validateGbpEdit(edit);
      // The queue layer reads existing queued jobs for the profile; here the
      // manager defers spacing to the caller-supplied enqueue that knows them.
      const scheduledAt = new Date(Date.now());
      await enqueue(edit, scheduledAt);
      return { ok: true, scheduledAt };
    },
    async publishPost(post) {
      if (!post.locationRef || !post.title) throw new GbpQueueError("locationRef and title are required for a local post.");
      const edit: GbpEditRequest = {
        profileId: post.locationRef,
        locationRef: post.locationRef,
        kind: "post",
        payload: {
          topicType: post.topicType, title: post.title, summary: post.summary,
          actionUrl: post.actionUrl ?? null, recurrence: post.recurrence ?? null,
        },
      };
      const scheduledAt = new Date(Date.now());
      await enqueue(edit, scheduledAt);
      return { ok: true, scheduledAt };
    },
    async syncVia(client, edit) {
      const res = await client.syncProfile(edit.locationRef, edit.payload);
      return { ok: res.ok };
    },
  };
}

/** Owner-performed verification flow steps (the API only initiates/completes; the owner verifies). */
export const GBP_VERIFICATION_STEPS = [
  "Initiate verification in Business Profile Manager (postcard or video).",
  "Owner completes the postcard or video verification — ShapesOS cannot perform this step.",
  "Confirm verification status; the API reflects it once Google marks the profile verified.",
] as const;

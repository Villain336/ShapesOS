// Marketr — R1 listing upkeep (GBP API) + review-media brand intelligence.
//
// SPEC-PHASE6.md §2/R1: listing upkeep (hours, attributes, categories, photo
// upload, local posts incl. recurring), review-media objects as a
// brand-intelligence surface.
//
// All edits go through the GBP client; listing edits are approval-bound at
// the route layer (listing_edit approval type). This module owns the payload
// shaping + the review-media fixture.

import type { GbpClient } from "../fake";
import type { ReviewMediaItem } from "./types";

export interface UpkeepPatch {
  hours?: Record<string, unknown> | null; // regular/special/category-specific
  attributes?: Record<string, unknown> | null;
  categories?: string[] | null;
  photos?: string[] | null; // photo URLs to upload
  posts?: Array<{
    topic: "offer" | "event" | "update";
    title: string;
    body: string;
    startDate?: string;
    endDate?: string;
    recurring?: boolean; // Recurrence Info, supported since 2026-04-07
  }> | null;
}

export interface UpkeepResult {
  locationRef: string;
  applied: (keyof UpkeepPatch)[];
  syncedAt: Date;
}

/** Validate + apply a listing upkeep patch via the GBP client. */
export async function upkeepListing(args: {
  workspaceId: string;
  locationRef: string;
  patch: UpkeepPatch;
  gbp: GbpClient;
}): Promise<UpkeepResult> {
  const { locationRef, patch, gbp } = args;
  const applied: (keyof UpkeepPatch)[] = [];
  const payload: Record<string, unknown> = { locationRef };

  if (patch.hours) {
    payload.hours = patch.hours;
    applied.push("hours");
  }
  if (patch.attributes) {
    payload.attributes = patch.attributes;
    applied.push("attributes");
  }
  if (patch.categories && patch.categories.length > 0) {
    if (patch.categories.length > 10) throw new Error("GBP allows at most 10 categories per location.");
    payload.categories = patch.categories;
    applied.push("categories");
  }
  if (patch.photos && patch.photos.length > 0) {
    if (patch.photos.length > 20) throw new Error("Photo upload batch exceeds the 20-photo limit.");
    payload.photos = patch.photos;
    applied.push("photos");
  }
  if (patch.posts && patch.posts.length > 0) {
    for (const post of patch.posts) {
      if (!post.title.trim() || !post.body.trim()) throw new Error("Local posts require a title and body.");
      if (post.topic === "event" && post.recurring && !post.startDate) {
        throw new Error("Recurring events require a startDate (Recurrence Info).");
      }
    }
    payload.posts = patch.posts;
    applied.push("posts");
  }

  if (applied.length === 0) throw new Error("Upkeep patch is empty — nothing to sync.");
  await gbp.syncProfile(locationRef, payload);
  return { locationRef, applied, syncedAt: new Date() };
}

// ---------------------------------------------------------------------------
// Review-media fixture (customer review photos as brand-intelligence).
// GBP customer-photo surfaces feed this in production; v1 ships a fixture so
// the UI/API contract is real and battery-testable.
// ---------------------------------------------------------------------------

const REVIEW_MEDIA_FIXTURE: ReviewMediaItem[] = [
  {
    reviewId: "fixture-review-1",
    mediaId: "fixture-media-1",
    mediaUrl: "https://example.invalid/review-media/fixture-1.jpg",
    caption: "Storefront at golden hour",
    flaggedAt: new Date("2026-09-20T12:00:00Z"),
    fixture: true,
  },
  {
    reviewId: "fixture-review-2",
    mediaId: "fixture-media-2",
    mediaUrl: "https://example.invalid/review-media/fixture-2.jpg",
    caption: "Product close-up",
    flaggedAt: new Date("2026-09-21T09:30:00Z"),
    fixture: true,
  },
];

export function listReviewMedia(locationRef: string): ReviewMediaItem[] {
  void locationRef;
  return REVIEW_MEDIA_FIXTURE;
}

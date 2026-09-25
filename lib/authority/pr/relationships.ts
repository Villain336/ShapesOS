// Marketr — O2 digital PR: relationship CRM-lite (pure).
// Per-journalist history, declination reasons, 90-day re-engagement windows,
// max-2-follow-up enforcement via assertJournalistSendAllowed (spec §9 inv 7).

import { assertJournalistSendAllowed } from "../guards";

export interface JournalistInteraction {
  ts: Date;
  kind: "pitched" | "followed_up" | "placed" | "declined" | "note";
  detail: string;
}

export interface RelationshipRecord {
  journalist: string;
  outlet: string;
  history: JournalistInteraction[];
  declinationReasons: string[];
  /** Journalists are never re-engaged inside this window after a declination. */
  reengagementEligibleAt: Date | null;
  followUpCount: number;
}

export const REENGAGEMENT_WINDOW_DAYS = 90;
export const MAX_FOLLOW_UPS = 2;
export const FOLLOW_UP_CADENCE_MS = 48 * 3600 * 1000;

export function blankRelationship(journalist: string, outlet: string): RelationshipRecord {
  return {
    journalist,
    outlet,
    history: [],
    declinationReasons: [],
    reengagementEligibleAt: null,
    followUpCount: 0,
  };
}

/** Append an interaction to the journalist's history. */
export function recordInteraction(
  rel: RelationshipRecord,
  kind: JournalistInteraction["kind"],
  detail: string,
  now = new Date(),
): RelationshipRecord {
  return {
    ...rel,
    history: [...rel.history, { ts: now, kind, detail }],
  };
}

/**
 * Record a declination: stores the reason and sets the 90-day
 * re-engagement window. Resets the follow-up counter for the next cycle.
 */
export function recordDeclination(
  rel: RelationshipRecord,
  reason: string,
  now = new Date(),
): RelationshipRecord {
  return {
    ...rel,
    declinationReasons: [...rel.declinationReasons, reason],
    reengagementEligibleAt: new Date(now.getTime() + REENGAGEMENT_WINDOW_DAYS * 24 * 3600 * 1000),
    followUpCount: 0,
    history: [...rel.history, { ts: now, kind: "declined", detail: reason }],
  };
}

/** True when the journalist may be re-engaged now (no declination, or window elapsed). */
export function reengagementEligible(rel: RelationshipRecord, now = new Date()): boolean {
  if (!rel.reengagementEligibleAt) return true;
  return now.getTime() >= rel.reengagementEligibleAt.getTime();
}

export function lastSentAt(rel: RelationshipRecord): Date | null {
  const sends = rel.history.filter((h) => h.kind === "pitched" || h.kind === "followed_up");
  if (sends.length === 0) return null;
  return sends[sends.length - 1].ts;
}

export interface FollowUpDecision {
  allowed: boolean;
  reason: string | null;
}

/**
 * Enforce the journalist ruleset before any send/follow-up. Throws via
 * assertJournalistSendAllowed when disallowed — fail closed. Returns the
 * updated record (followUpCount incremented) on success.
 */
export function authorizeSend(rel: RelationshipRecord, opts: {
  subject: string;
  hasAttachment: boolean;
  isBcc: boolean;
  now?: Date;
}): { allowed: true; updated: RelationshipRecord } {
  const now = opts.now ?? new Date();
  if (!reengagementEligible(rel, now)) {
    throw new Error(
      `Re-engagement blocked until ${rel.reengagementEligibleAt!.toISOString().slice(0, 10)} (90-day declination window).`,
    );
  }
  assertJournalistSendAllowed({
    followUpCount: rel.followUpCount,
    lastSentAt: lastSentAt(rel),
    hasAttachment: opts.hasAttachment,
    isBcc: opts.isBcc,
    subject: opts.subject,
    now,
  });
  const kind: JournalistInteraction["kind"] = rel.followUpCount === 0 ? "pitched" : "followed_up";
  const updated = recordInteraction(rel, kind, `subject: ${opts.subject}`, now);
  updated.followUpCount = rel.followUpCount + 1;
  return { allowed: true, updated };
}

/** Non-throwing preview of the same decision (for UI gating). */
export function previewSendDecision(rel: RelationshipRecord, opts: {
  subject: string;
  hasAttachment: boolean;
  isBcc: boolean;
  now?: Date;
}): FollowUpDecision {
  const now = opts.now ?? new Date();
  try {
    if (!reengagementEligible(rel, now)) {
      return { allowed: false, reason: "90-day re-engagement window after declination" };
    }
    assertJournalistSendAllowed({
      followUpCount: rel.followUpCount,
      lastSentAt: lastSentAt(rel),
      hasAttachment: opts.hasAttachment,
      isBcc: opts.isBcc,
      subject: opts.subject,
      now,
    });
    return { allowed: true, reason: null };
  } catch (err) {
    return { allowed: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

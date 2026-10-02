// Marketr — Connector Agent slice 4: double-opt-in lifecycle (pure domain).
// SPEC-CONNECTOR-AGENT.md §3/§6: the Introduction state machine is the
// reputation-critical core. Everything here is pure (no DB, no wall clock)
// so the transition law, the human-only actor rule, rate-limit windows, and
// expiry math are pinned by tests independent of the store.
//
// Lifecycle:
//   proposed → side_a_accepted → side_b_accepted → made → followed_up
//   Terminal: declined, expired, withdrawn.
//
// Side A = the mutual contact (the ask goes to them first, after the
// tenant approves the draft). Side B = the target (the offer goes to them
// only after side A accepts). Nothing sends before both acceptances —
// make_intro is legal ONLY from side_b_accepted.

import { ConnectorError } from "./types";

// ---------------------------------------------------------------------------
// Statuses.
// ---------------------------------------------------------------------------

export const CONNECTOR_INTRO_STATUSES = [
  "proposed",
  "side_a_accepted",
  "side_b_accepted",
  "made",
  "followed_up",
  "declined",
  "expired",
  "withdrawn",
] as const;
export type ConnectorIntroductionStatus =
  (typeof CONNECTOR_INTRO_STATUSES)[number];

/** Statuses that still count toward the one-intro-per-pair rule. */
export const CONNECTOR_INTRO_ACTIVE_STATUSES: ConnectorIntroductionStatus[] = [
  "proposed",
  "side_a_accepted",
  "side_b_accepted",
  "made",
  "followed_up",
];

/** Terminal states — no transitions out, ever. */
export const CONNECTOR_INTRO_TERMINAL_STATUSES: ConnectorIntroductionStatus[] = [
  "declined",
  "expired",
  "withdrawn",
];

// ---------------------------------------------------------------------------
// Transition law.
// ---------------------------------------------------------------------------

/** The governed verbs on an Introduction. */
export const CONNECTOR_INTRO_EVENTS = [
  "tenant_approve",
  "tenant_decline",
  "side_a_accept",
  "side_a_decline",
  "side_b_accept",
  "side_b_decline",
  "make",
  "followup_propose",
  "followup_approve",
  "withdraw",
  "expire",
] as const;
export type ConnectorIntroEvent = (typeof CONNECTOR_INTRO_EVENTS)[number];

/**
 * From → the events that are legal. The resulting status is derived by
 * introTransitionTarget. Anything not in this table is rejected with
 * invalid_transition.
 *
 * Notes:
 * - side_a_* require the tenant to have approved the draft (the ask is
 *   only sent after approval — side A cannot act on an ask they never saw).
 * - side_b_* require side_a_accepted (the offer only goes out after A).
 * - make is legal ONLY from side_b_accepted (the money rule).
 * - followup_propose is legal from made and followed_up; followup_approve
 *   (the tenant approves the nudge draft AND it sends) is legal from made
 *   and followed_up only while a followup draft is pending — the store
 *   enforces the pending-draft half; the table enforces the state half.
 * - expire is legal ONLY from proposed (per the spec's expiry rule).
 */
export const CONNECTOR_INTRO_TRANSITIONS: Record<
  ConnectorIntroductionStatus,
  ConnectorIntroEvent[]
> = {
  proposed: [
    "tenant_approve",
    "tenant_decline",
    "side_a_accept",
    "side_a_decline",
    "withdraw",
    "expire",
  ],
  side_a_accepted: ["side_b_accept", "side_b_decline", "withdraw"],
  side_b_accepted: ["make", "withdraw"],
  made: ["followup_propose", "followup_approve"],
  followed_up: ["followup_propose", "followup_approve"],
  declined: [],
  expired: [],
  withdrawn: [],
};

export const CONNECTOR_INTRO_EVENT_TARGETS: Record<
  ConnectorIntroEvent,
  ConnectorIntroductionStatus
> = {
  tenant_approve: "proposed", // stays proposed; the approval is a flag
  tenant_decline: "declined",
  side_a_accept: "side_a_accepted",
  side_a_decline: "declined",
  side_b_accept: "side_b_accepted",
  side_b_decline: "declined",
  make: "made",
  followup_propose: "followed_up", // set at approve time; propose keeps state
  followup_approve: "followed_up",
  withdraw: "withdrawn",
  expire: "expired",
};

/** Throw ConnectorError("invalid_transition") unless the event is legal. */
export function assertIntroTransition(
  from: ConnectorIntroductionStatus,
  event: ConnectorIntroEvent,
): void {
  const legal = CONNECTOR_INTRO_TRANSITIONS[from] ?? [];
  if (!legal.includes(event)) {
    throw new ConnectorError(
      "invalid_transition",
      `Cannot ${event} from ${from}. Legal events: ${legal.join(", ") || "none (terminal)"}.`,
    );
  }
}

/**
 * Extra preconditions the bare table cannot express. Called by the store
 * after assertIntroTransition. Throws ConnectorError.
 *
 * - tenantApproved: side_a_accept / side_a_decline need the tenant's
 *   approval (the ask is only sent after approval).
 * - pendingFollowupDraft: followup_approve needs a pending followup draft.
 */
export function assertIntroPreconditions(opts: {
  event: ConnectorIntroEvent;
  tenantApproved: boolean;
  pendingFollowupDraft: boolean;
}): void {
  if (
    (opts.event === "side_a_accept" || opts.event === "side_a_decline") &&
    !opts.tenantApproved
  ) {
    throw new ConnectorError(
      "tenant_approval_required",
      "Side A cannot act before the tenant approves the draft — the ask is only sent after approval.",
    );
  }
  if (opts.event === "followup_propose" && opts.pendingFollowupDraft) {
    throw new ConnectorError(
      "followup_pending",
      "A followup draft is already pending tenant approval for this introduction.",
    );
  }
  if (opts.event === "followup_approve" && !opts.pendingFollowupDraft) {
    throw new ConnectorError(
      "no_followup_pending",
      "No followup draft is pending tenant approval.",
    );
  }
}

// ---------------------------------------------------------------------------
// Actors — human-only accept/decline.
// ---------------------------------------------------------------------------

/**
 * Who performs a governed action. accept/decline are HUMAN actions only:
 * the agent (or any code path) cannot accept on anyone's behalf — including
 * the tenant's. The store enforces this at runtime with requireHumanActor;
 * the type alone is not the enforcement (callers can cast).
 */
export type IntroActor =
  | { kind: "human"; identity: string }
  | { kind: "agent"; identity?: string };

/** The tenant human who approves drafts (the signed-in user). */
export type TenantActor = { kind: "human"; identity: string };

/**
 * Enforce the human-only rule. Rejects agent actors (code: agent_cannot_act)
 * and empty identities (code: invalid_actor). Returns the trimmed identity.
 */
export function requireHumanActor(actor: IntroActor, action: string): string {
  if (!actor || actor.kind !== "human") {
    throw new ConnectorError(
      "agent_cannot_act",
      `${action} is a human-only action: the agent cannot accept or decline on anyone's behalf, including the tenant's. A human identity is required.`,
    );
  }
  const identity = actor.identity.trim();
  if (!identity) {
    throw new ConnectorError(
      "invalid_actor",
      `${action} requires a non-empty human identity.`,
    );
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Audit event kinds (what was said, by whom, when — the lineage).
// ---------------------------------------------------------------------------

export const CONNECTOR_INTRO_AUDIT_KINDS = [
  "proposed",
  "tenant_approved",
  "tenant_declined",
  "ask_sent_to_side_a",
  "side_a_accepted",
  "side_a_declined",
  "offer_sent_to_side_b",
  "side_b_accepted",
  "side_b_declined",
  "intro_sent",
  "followup_proposed",
  "followup_sent",
  "withdrawn",
  "expired",
] as const;
export type ConnectorIntroAuditKind =
  (typeof CONNECTOR_INTRO_AUDIT_KINDS)[number];

export const CONNECTOR_INTRO_ACTOR_KINDS = [
  "agent",
  "tenant",
  "side_a",
  "side_b",
  "system",
] as const;
export type ConnectorIntroActorKind =
  (typeof CONNECTOR_INTRO_ACTOR_KINDS)[number];

// ---------------------------------------------------------------------------
// Rate limits — per mutual (side A), per window.
// ---------------------------------------------------------------------------

/** Default: max one intro ask per mutual per quarter (91-day rolling). */
export const DEFAULT_INTRO_ASK_WINDOW_DAYS = 91;
export const DEFAULT_INTRO_MAX_ASKS_PER_WINDOW = 1;

export interface IntroAskWindow {
  /** Rolling window length in days. */
  windowDays: number;
  /** Max intro asks to this mutual inside the window. */
  maxAsks: number;
}

/**
 * Honor the relationship's free-text boundaries when sizing the ask
 * window. Keyword parse (case-insensitive):
 *   "never ask" / "no intros" / "don't ask" → blocked
 *   "weekly" → 1 ask / 7d · "monthly" → 1 ask / 31d
 *   "quarterly" → 1 ask / 91d · "yearly"/"annual" → 1 ask / 365d
 *   anything else / null → the default (1 ask / 91d).
 * Pure — pinned by tests.
 */
export function introAskWindow(
  boundaries: string | null,
): IntroAskWindow | { blocked: true } {
  const text = (boundaries ?? "").toLowerCase();
  // Specific cadence keywords win over the never-ask patterns: "don't ask
  // for intros more than monthly" is a monthly limit, not a ban.
  if (/weekly/.test(text)) return { windowDays: 7, maxAsks: 1 };
  if (/monthly/.test(text)) return { windowDays: 31, maxAsks: 1 };
  if (/quarter/.test(text)) return { windowDays: 91, maxAsks: 1 };
  if (/yearly|annual/.test(text)) return { windowDays: 365, maxAsks: 1 };
  if (
    /never\s+(ask|introduce|introduction)|no\s+intro|do\s*n't\s+ask|don't\s+ask/.test(
      text,
    )
  ) {
    return { blocked: true };
  }
  return {
    windowDays: DEFAULT_INTRO_ASK_WINDOW_DAYS,
    maxAsks: DEFAULT_INTRO_MAX_ASKS_PER_WINDOW,
  };
}

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

/** Default expiry window for unanswered proposals: 14 days. */
export const DEFAULT_INTRO_EXPIRY_DAYS = 14;

/** Pure: is this proposal past its expiry window? */
export function isIntroExpired(
  proposedAt: Date,
  now: Date,
  expiryDays: number,
): boolean {
  if (!(expiryDays > 0)) return false;
  return now.getTime() - proposedAt.getTime() >= expiryDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Draft + followup validation (pure).
// ---------------------------------------------------------------------------

/** Drafts are data — but they must be real copy, not placeholders. */
export const MIN_DRAFT_MESSAGE_LENGTH = 20;

export interface ProposeIntroductionInput {
  personAId?: unknown; // the mutual (side A)
  personBId?: unknown; // the target (side B)
  /** The computed IntroPath used, frozen as a JSON-serializable snapshot. */
  introPath?: unknown;
  /** Draft ask to side A (sent after tenant approval). */
  draftAskMessage?: unknown;
  /** Draft offer to side B (sent after side A accepts). */
  draftOfferMessage?: unknown;
  /** Optional per-instance rate-limit override (tenant-set, recorded). */
  rateLimitOverride?: unknown;
}

export interface ValidProposeIntroductionInput {
  personAId: string;
  personBId: string;
  introPath: Record<string, unknown>;
  draftAskMessage: string;
  draftOfferMessage: string;
  rateLimitOverride: { maxAsks: number; windowDays: number } | null;
}

function draftMessage(value: unknown, field: string, errors: string[]): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < MIN_DRAFT_MESSAGE_LENGTH) {
    errors.push(
      `${field} is required and must be at least ${MIN_DRAFT_MESSAGE_LENGTH} characters of real copy.`,
    );
    return null;
  }
  return text;
}

export function validateProposeIntroductionInput(
  input: ProposeIntroductionInput,
): { errors: string[]; value: ValidProposeIntroductionInput | null } {
  const errors: string[] = [];
  const personAId =
    typeof input.personAId === "string" ? input.personAId.trim() : "";
  const personBId =
    typeof input.personBId === "string" ? input.personBId.trim() : "";
  if (!personAId) errors.push("personAId is required (the mutual, side A).");
  if (!personBId) errors.push("personBId is required (the target, side B).");
  if (personAId && personBId && personAId === personBId) {
    errors.push("personAId and personBId must be different people.");
  }

  let introPath: Record<string, unknown> | null = null;
  if (
    input.introPath != null &&
    typeof input.introPath === "object" &&
    !Array.isArray(input.introPath)
  ) {
    const snap = input.introPath as Record<string, unknown>;
    const mutual = snap["mutual"] as { id?: unknown } | undefined;
    if (mutual && typeof mutual.id === "string" && mutual.id.trim()) {
      introPath = snap;
    } else {
      errors.push(
        "introPath must be a computed IntroPath snapshot with a mutual contact.",
      );
    }
  } else {
    errors.push(
      "introPath is required — every intro is warm by construction; it must ride a computed IntroPath.",
    );
  }

  const draftAskMessage = draftMessage(input.draftAskMessage, "draftAskMessage", errors);
  const draftOfferMessage = draftMessage(input.draftOfferMessage, "draftOfferMessage", errors);

  let rateLimitOverride: { maxAsks: number; windowDays: number } | null = null;
  if (input.rateLimitOverride != null) {
    const o = input.rateLimitOverride as Record<string, unknown>;
    const maxAsks = Number(o["maxAsks"]);
    const windowDays = Number(o["windowDays"]);
    if (
      !Number.isInteger(maxAsks) ||
      maxAsks < 1 ||
      maxAsks > 10 ||
      !Number.isInteger(windowDays) ||
      windowDays < 1 ||
      windowDays > 730
    ) {
      errors.push(
        "rateLimitOverride must be { maxAsks: 1–10, windowDays: 1–730 } when provided.",
      );
    } else {
      rateLimitOverride = { maxAsks, windowDays };
    }
  }

  if (errors.length > 0 || !introPath || !draftAskMessage || !draftOfferMessage) {
    return { errors, value: null };
  }
  return {
    errors,
    value: {
      personAId,
      personBId,
      introPath,
      draftAskMessage,
      draftOfferMessage,
      rateLimitOverride,
    },
  };
}

export interface FollowupInput {
  draft?: unknown;
  to?: unknown;
}

export interface ValidFollowupInput {
  draft: string;
  to: "side_a" | "side_b" | "both";
}

export function validateFollowupInput(
  input: FollowupInput,
): { errors: string[]; value: ValidFollowupInput | null } {
  const errors: string[] = [];
  const draft = draftMessage(input.draft, "draft", errors);
  const to =
    input.to === "side_a" || input.to === "side_b" || input.to === "both"
      ? input.to
      : null;
  if (!to) errors.push('to must be one of: "side_a", "side_b", "both".');
  if (errors.length > 0 || !draft || !to) return { errors, value: null };
  return { errors, value: { draft, to } };
}

export interface IntroSendInput {
  /** The tenant's connected messaging account/channel, e.g. "gmail". */
  sentVia?: unknown;
  /** The final message body actually sent (recorded on the audit event). */
  message?: unknown;
}

export interface ValidIntroSendInput {
  sentVia: string;
  message: string;
}

export function validateIntroSendInput(
  input: IntroSendInput,
): { errors: string[]; value: ValidIntroSendInput | null } {
  const errors: string[] = [];
  const sentVia =
    typeof input.sentVia === "string" ? input.sentVia.trim() : "";
  if (!sentVia) {
    errors.push(
      "sentVia is required — sends happen only via the tenant's connected messaging account.",
    );
  }
  const message = draftMessage(input.message, "message", errors);
  if (errors.length > 0 || !message) return { errors, value: null };
  return { errors, value: { sentVia, message } };
}

// ---------------------------------------------------------------------------
// View types.
// ---------------------------------------------------------------------------

export interface ConnectorIntroductionPersonRef {
  id: string;
  name: string;
  handles: string[];
}

export interface ConnectorIntroductionEventView {
  id: string;
  kind: ConnectorIntroAuditKind;
  actorKind: ConnectorIntroActorKind;
  actorIdentity: string;
  message: string | null;
  createdAt: Date;
}

export interface ConnectorIntroductionView {
  id: string;
  personA: ConnectorIntroductionPersonRef;
  personB: ConnectorIntroductionPersonRef;
  status: ConnectorIntroductionStatus;
  /** The computed IntroPath used, frozen at propose time. */
  introPathSnapshot: Record<string, unknown>;
  draftAskMessage: string;
  draftOfferMessage: string;
  tenantApproved: boolean;
  tenantApprovedBy: string | null;
  tenantApprovedAt: Date | null;
  sideAAcceptedBy: string | null;
  sideAAcceptedAt: Date | null;
  sideBAcceptedBy: string | null;
  sideBAcceptedAt: Date | null;
  madeMessage: string | null;
  madeSentVia: string | null;
  madeSentBy: string | null;
  madeSentAt: Date | null;
  declinedBy: string | null;
  declinedAt: Date | null;
  declineReason: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  expiredAt: Date | null;
  rateLimitOverrideMaxAsks: number | null;
  rateLimitOverrideWindowDays: number | null;
  followupCount: number;
  pendingFollowupDraft: string | null;
  pendingFollowupTo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorIntroductionDetailView extends ConnectorIntroductionView {
  /** Full lineage: every approval event, chronological. */
  events: ConnectorIntroductionEventView[];
}

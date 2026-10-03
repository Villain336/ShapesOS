// Marketr — Phase 5 S1: generalized C3 trust ladder for media buying.
//
// The fix-agent ladder promoted to a platform primitive. Every money-moving
// module declares its rung, escalation triggers, and rollback story.
//
// STRUCTURAL INVARIANTS (enforced in code, not config — see also
// SPEC-PHASE5.md §9):
//   1. Autopilot NEVER buys media. Buying modules carry neverAutopilot: true
//      and the executor's requireHumanSupervisedApproval() throws unless a
//      human-approved approval backs the execution. There is no rung, flag,
//      or exception path that reaches autopilot purchasing.
//   2. ZERO custody: BudgetPool is an accounting object only — Marketr never
//      holds, fronts, or co-mingles client money. (See lib/media/pools.ts.)

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { requireSecret } from "@/lib/env/secrets";

export type LadderRung = "manual" | "supervised" | "scheduled" | "autopilot";

export type MediaModule =
  | "dooh_buy"
  | "audio_buy"
  | "io_brief"
  | "pool_draw"
  | "budget_reallocation"
  | "media_planning"
  | "attribution_compute"
  | "receipt_reconciliation"
  | "creative_generation"
  | "kill_rule_eval"
  | "emergency_stop";

export interface RungAssignment {
  rung: LadderRung;
  /** When true, the module can NEVER run on the autopilot rung — invariant. */
  neverAutopilot: boolean;
  escalation: string;
  rollback: string;
}

// Rung assignments (fixed per SPEC-PHASE5.md §2 S1):
// - all media buying = supervised, always
// - planning / attribution computation / receipt reconciliation = scheduled/autopilot-safe
// - budget reallocations = supervised (propose; human approves)
export const MODULE_RUNGS: Record<MediaModule, RungAssignment> = {
  dooh_buy: {
    rung: "supervised",
    neverAutopilot: true,
    escalation: "Human approval required per buy (two-person rules).",
    rollback: "Kill-switch pause; IO cancel terms per binding.",
  },
  audio_buy: {
    rung: "supervised",
    neverAutopilot: true,
    escalation: "Human approval required per buy (two-person rules).",
    rollback: "Platform pause; insertion cancel terms per binding.",
  },
  io_brief: {
    rung: "supervised",
    neverAutopilot: true,
    escalation: "Owner approval required; rep executes the signature.",
    rollback: "IO unsigned → void; signed → cancel per IAB/AAAA terms.",
  },
  pool_draw: {
    rung: "supervised",
    neverAutopilot: true,
    escalation: "Owner approval; encumbrance only against pool cap.",
    rollback: "Encumbrance released on expiry/revocation.",
  },
  budget_reallocation: {
    rung: "supervised",
    neverAutopilot: true,
    escalation: "Proposed by buyer/agent; approved by owner. Never >20%/change without fresh approval.",
    rollback: "Re-approval of prior allocation; sweeper holds old caps.",
  },
  media_planning: {
    rung: "scheduled",
    neverAutopilot: false,
    escalation: "Plans are advisory until a buy is proposed.",
    rollback: "Discard plan draft.",
  },
  attribution_compute: {
    rung: "autopilot",
    neverAutopilot: false,
    escalation: "Computation only — moves no money.",
    rollback: "Recompute; snapshots are immutable.",
  },
  receipt_reconciliation: {
    rung: "autopilot",
    neverAutopilot: false,
    escalation: "Read-only vs platform actuals; variance surfaced, never silent.",
    rollback: "Re-run reconciliation.",
  },
  creative_generation: {
    rung: "supervised",
    neverAutopilot: false,
    escalation: "Creatives hash-stamped; approval object binds the hash.",
    rollback: "Regenerate; stale hashes fail pre-flight.",
  },
  kill_rule_eval: {
    rung: "autopilot",
    neverAutopilot: false,
    escalation: "Actions limited to pause/reduce_budget/alert per human-set rules.",
    rollback: "Rule toggle; every action logged to the approval event log.",
  },
  emergency_stop: {
    rung: "manual",
    neverAutopilot: true,
    escalation: "Approver role + written reason required.",
    rollback: "Pools unfrozen by owner; approvals re-enter the queue.",
  },
};

export class SafetyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyViolationError";
  }
}

export class AutopilotBuyBlockedError extends SafetyViolationError {
  constructor(module: MediaModule) {
    // The €7,937/day failure class (Apr 2026: a 25% hourly budget increase
    // compounding to €7,937/day in 4 days — no persisted state, no
    // account-level ceiling) exists because automation could move money
    // unsupervised. This invariant is why that class cannot recur here.
    super(
      `AUTOPILOT_BUY_BLOCKED: module "${module}" moves money and carries ` +
        `neverAutopilot=true. Autopilot never buys media — structural invariant, ` +
        `not a config flag. A human-approved approval is required.`,
    );
    this.name = "AutopilotBuyBlockedError";
  }
}

/**
 * Structural gate every media execution path must call. Throws unless the
 * module's rung assignment permits the requested execution mode AND a
 * human-approved approval backs the execution.
 */
export function requireHumanSupervisedApproval(
  module: MediaModule,
  approval: { status: string; approvers: unknown[] } | null,
): void {
  const assignment = MODULE_RUNGS[module];
  if (!assignment) throw new SafetyViolationError(`Unknown media module "${module}".`);
  if (assignment.neverAutopilot && !approval) {
    throw new AutopilotBuyBlockedError(module);
  }
  if (assignment.neverAutopilot) {
    if (!approval || approval.status !== "approved") {
      throw new SafetyViolationError(
        `Module "${module}" requires an approval in status "approved" (got "${approval?.status ?? "none"}").`,
      );
    }
    if (!Array.isArray(approval.approvers) || approval.approvers.length === 0) {
      throw new SafetyViolationError(
        `Module "${module}" requires at least one recorded human approver.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Approval state machine: draft → pending → approved → executed | expired | revoked
// ---------------------------------------------------------------------------

export type ApprovalStatus = "draft" | "pending" | "approved" | "executed" | "expired" | "revoked";

const TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  draft: ["pending", "revoked"],
  pending: ["approved", "expired", "revoked", "draft"],
  approved: ["executed", "expired", "revoked"],
  executed: [],
  expired: ["pending"], // stale approvals re-enter the queue — never execute
  revoked: [],
};

export class IllegalApprovalTransitionError extends SafetyViolationError {
  constructor(from: ApprovalStatus, to: ApprovalStatus) {
    super(`Illegal approval transition: ${from} → ${to}.`);
    this.name = "IllegalApprovalTransitionError";
  }
}

/** Throws on illegal transitions. Pure — the store applies the update. */
export function assertApprovalTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) throw new IllegalApprovalTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// Two-person rules
// ---------------------------------------------------------------------------

/** Default second-approver threshold: $1K (approved by Tico 2026-09-25). */
export const DEFAULT_TWO_PERSON_THRESHOLD_CENTS = 100_000;

export function twoPersonThresholdCents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEDIA_TWO_PERSON_THRESHOLD_CENTS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return DEFAULT_TWO_PERSON_THRESHOLD_CENTS;
}

export interface TwoPersonInput {
  creatorId: string;
  approverIds: string[];
  maxSpendCents: number;
  thresholdCents?: number;
}

export class TwoPersonViolationError extends SafetyViolationError {
  constructor(message: string) {
    super(message);
    this.name = "TwoPersonViolationError";
  }
}

/**
 * Separation of duties as a fraud control (service-layer enforcement):
 * - creator ≠ approver, ALWAYS (buyers propose but never approve)
 * - second approver required above the two-person threshold (default $1K)
 *
 * Non-throwing evaluation. Hard violations (creator approving) are returned
 * as violations; a short approver count is NOT a violation — it means the
 * buy stays pending until the second approver decides.
 */
export function checkTwoPerson(input: TwoPersonInput): { satisfied: boolean; violations: string[] } {
  const { creatorId, approverIds, maxSpendCents } = input;
  const threshold = input.thresholdCents ?? DEFAULT_TWO_PERSON_THRESHOLD_CENTS;
  const unique = [...new Set(approverIds)];
  const violations: string[] = [];
  if (unique.length === 0) violations.push("At least one approver is required.");
  if (unique.includes(creatorId)) {
    violations.push("Creator cannot approve their own buy — buyers propose but never approve.");
  }
  const satisfied = violations.length === 0 && (maxSpendCents < threshold || unique.length >= 2);
  return { satisfied, violations };
}

/**
 * Throwing variant: satisfied AND violation-free, or throw.
 * Used by direct checks (tests, guards); the approval flow uses
 * checkTwoPerson to accumulate multi-approver decisions.
 */
export function assertTwoPerson(input: TwoPersonInput): void {
  const { satisfied, violations } = checkTwoPerson(input);
  const threshold = input.thresholdCents ?? DEFAULT_TWO_PERSON_THRESHOLD_CENTS;
  if (violations.length > 0) throw new TwoPersonViolationError(violations.join(" "));
  if (!satisfied) {
    throw new TwoPersonViolationError(
      `Second approver required above the two-person threshold ($${(threshold / 100).toFixed(0)}).`,
    );
  }
}

/**
 * Backup approvers: derived from workspace owners/admins (excluding the
 * creator) so there is never an approval dead-end when the owner is offline.
 * Memberships come from the existing workspaceMember rows — no new table.
 */
export function resolveBackupApprovers(
  memberships: Array<{ userId: string; role: string }>,
  excludeUserId: string,
): string[] {
  return memberships
    .filter((m) => (m.role === "owner" || m.role === "admin") && m.userId !== excludeUserId)
    .map((m) => m.userId);
}

// ---------------------------------------------------------------------------
// Execution window: approvals must execute within 72h of approval.
// ---------------------------------------------------------------------------

export const EXECUTION_WINDOW_HOURS = 72;

export function executionWindowHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEDIA_EXECUTION_WINDOW_HOURS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return EXECUTION_WINDOW_HOURS;
}

export function approvalsExpiresAt(approvedAt: Date, hours = EXECUTION_WINDOW_HOURS): Date {
  return new Date(approvedAt.getTime() + hours * 60 * 60 * 1000);
}

export function isApprovalExpired(expiresAt: Date | null, now: Date = new Date()): boolean {
  return !!expiresAt && now >= expiresAt;
}

// ---------------------------------------------------------------------------
// Media roles: owner / media_buyer / viewer (mapped from workspace roles).
// Buyers propose but never approve — enforced in the service layer.
// ---------------------------------------------------------------------------

export type MediaRole = "owner" | "media_buyer" | "viewer";

export function mediaRoleForWorkspaceRole(workspaceRole: string): MediaRole {
  if (workspaceRole === "owner" || workspaceRole === "admin") return "owner";
  if (workspaceRole === "editor") return "media_buyer";
  return "viewer";
}

export function assertCanApprove(mediaRole: MediaRole): void {
  if (mediaRole !== "owner") {
    throw new SafetyViolationError(
      `Approvals require the media "owner" role (got "${mediaRole}"). Buyers propose but never approve.`,
    );
  }
}

export function assertCanPropose(mediaRole: MediaRole): void {
  if (mediaRole === "viewer") {
    throw new SafetyViolationError("Viewers cannot propose media buys.");
  }
}

// ---------------------------------------------------------------------------
// OTP challenge for high-value approvals + cryptographically verified receipt
// ---------------------------------------------------------------------------

/** What a challenge is bound to: one approval, one approver (Phase 1). */
export interface OtpBinding {
  approvalId: string;
  approverId: string;
}

export interface OtpChallenge extends OtpBinding {
  challengeId: string;
  codeHash: string;
  expiresAt: Date;
  /** Wrong guesses so far; the challenge is burned at OTP_MAX_ATTEMPTS. */
  attempts: number;
}

/** Wrong guesses allowed per challenge before it is burned (Phase 1). */
export const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PENDING = 10_000;

function hashOtp(code: string): string {
  return createHash("sha256").update(code.trim(), "utf8").digest("hex");
}

/**
 * In-memory challenge store. PRODUCTION NOTE: persist challenges in the DB
 * or a short-lived KV store — a process restart must not resurrect or lose
 * pending challenges silently.
 *
 * Phase 1 hardening:
 *   - codes come from crypto.randomInt (never Math.random);
 *   - only the SHA-256 of the code is kept — the plaintext exists once, in
 *     mint()'s return value, for the server to deliver out-of-band (email);
 *     it is never returned by an API route;
 *   - a challenge is bound to one approval AND one approver;
 *   - OTP_MAX_ATTEMPTS wrong guesses burn the challenge;
 *   - single-use.
 */
export class OtpChallengeStore {
  private challenges = new Map<string, OtpChallenge>();

  mint(binding: OtpBinding, ttlMinutes = 10): { challengeId: string; code: string; expiresAt: Date } {
    const now = Date.now();
    this.prune(now);
    const challengeId = `otp_${randomBytes(12).toString("hex")}`;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(now + ttlMinutes * 60 * 1000);
    this.challenges.set(challengeId, {
      challengeId,
      codeHash: hashOtp(code),
      expiresAt,
      attempts: 0,
      approvalId: binding.approvalId,
      approverId: binding.approverId,
    });
    // The code is returned to the SERVER caller for out-of-band delivery.
    // Never log it, never store it, never put it in an API response.
    return { challengeId, code, expiresAt };
  }

  verify(challengeId: string, code: string, binding: OtpBinding, now: Date = new Date()): boolean {
    const ch = this.challenges.get(challengeId);
    if (!ch) return false;
    if (now >= ch.expiresAt) {
      this.challenges.delete(challengeId);
      return false;
    }
    const candidate = hashOtp(code);
    const codeOk =
      candidate.length === ch.codeHash.length &&
      timingSafeEqual(Buffer.from(candidate), Buffer.from(ch.codeHash));
    const bound = ch.approvalId === binding.approvalId && ch.approverId === binding.approverId;
    if (codeOk && bound) {
      this.challenges.delete(challengeId); // single-use
      return true;
    }
    ch.attempts += 1;
    if (ch.attempts >= OTP_MAX_ATTEMPTS) this.challenges.delete(challengeId);
    return false;
  }

  /** Drop expired challenges; past the cap, drop the oldest (bounded memory). */
  private prune(now: number): void {
    for (const [id, ch] of this.challenges) {
      if (ch.expiresAt.getTime() <= now) this.challenges.delete(id);
    }
    while (this.challenges.size >= OTP_MAX_PENDING) {
      const oldest = this.challenges.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
  }
}

export function approvalReceiptSecret(env: NodeJS.ProcessEnv = process.env): string {
  return requireSecret("MARKETR_APPROVAL_SECRET", "marketr-approval-dev-secret", env);
}

/**
 * Cryptographically verified approval record (PubMatic AgenticOS pattern):
 * HMAC(secret, approvalId || bindingHash || approverId || decidedAt).
 * Anyone with the secret can re-verify the record offline.
 */
export function signApprovalReceipt(opts: {
  approvalId: string;
  bindingHash: string;
  approverId: string;
  decidedAt: Date;
  secret?: string;
}): string {
  const secret = opts.secret ?? approvalReceiptSecret();
  return createHmac("sha256", secret)
    .update(
      [opts.approvalId, opts.bindingHash, opts.approverId, opts.decidedAt.toISOString()].join("|"),
      "utf8",
    )
    .digest("hex");
}

export function verifyApprovalReceipt(
  receipt: string,
  opts: { approvalId: string; bindingHash: string; approverId: string; decidedAt: Date; secret?: string },
): boolean {
  const expected = signApprovalReceipt(opts);
  return (
    receipt.length === expected.length &&
    timingSafeEqual(Buffer.from(receipt), Buffer.from(expected))
  );
}

/** sha256 hex helper (shared by binding + event chaining). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

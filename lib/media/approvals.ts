// Marketr — Phase 5 S3: per-buy binding approval object.
//
// The red-lane core: what was approved is exactly what executes, or nothing
// executes. The approval cryptographically binds inventory, exact spend,
// creative hashes, flight dates, and terms via SHA-256 of the canonical
// binding JSON. Any field change between approval and execution invalidates
// the hash → the executor HALTs and the buy re-enters approval (TOCTOU kill,
// SPEC-PHASE5.md §9.3).
//
// Audit: append-only media_approval_events with a hash chain
// (event_hash = sha256(prev_hash || canonical(ts, approval_id, actor,
// action, payload_hash))) — the IAB event-bus pattern.

import {
  ApprovalStatus,
  OtpChallengeStore,
  SafetyViolationError,
  approvalsExpiresAt,
  assertApprovalTransition,
  assertCanApprove,
  checkTwoPerson,
  TwoPersonViolationError,
  executionWindowHours,
  isApprovalExpired,
  sha256Hex,
  signApprovalReceipt,
  verifyApprovalReceipt,
  type MediaRole,
} from "./safety";

export type DealType = "auction" | "pd" | "pg" | "pa";
export type ApprovalType = "buy" | "io_brief" | "pool_draw";
export type ApprovalMethod = "none" | "sso" | "otp" | "signed_link";

export interface BindingLineItem {
  inventory: string;
  pricingModel: string;
  maxAllowedCents: number;
  flightStart: string; // ISO date
  flightEnd: string; // ISO date
  targetingSnapshot: Record<string, unknown>;
  creativeIds: string[];
  /** sha256 per creative — executor re-hashes; mismatch = halt. */
  creativeHashes: string[];
}

/** Immutable once approved. */
export interface BuyBinding {
  platform: string;
  clientAdAccountId: string;
  dealType: DealType;
  lineItems: BindingLineItem[];
  maxTotalSpendCents: number;
  currency: string;
  quoteId?: string;
  quoteExpiresAt?: string; // ISO
  driftTolerance: { pricePct: number; spendPct: number };
  creativeIds: string[];
  creativeHashes: string[];
  flightStart: string;
  flightEnd: string;
  targetingSnapshot: Record<string, unknown>;
  cancelTerms: string;
  operatorTermsVersion: string;
}

export interface ApproverRecord {
  userId: string;
  decidedAt: string; // ISO
  method: ApprovalMethod;
  receipt: string;
}

export interface MediaApproval {
  id: string;
  workspaceId: string;
  clientId: string | null;
  type: ApprovalType;
  status: ApprovalStatus;
  binding: BuyBinding;
  bindingHash: string;
  maxSpendCents: number;
  currency: string;
  poolId: string | null;
  quoteId: string | null;
  quoteExpiresAt: Date | null;
  driftTolerance: { pricePct: number; spendPct: number };
  createdBy: string;
  approvers: ApproverRecord[];
  twoPersonSatisfied: boolean;
  approvalMethod: ApprovalMethod;
  approvalReceipt: string | null;
  approvalsExpiresAt: Date | null;
  approvedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  executedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ApprovalEventAction =
  | "created" | "submitted" | "approved" | "approval_rejected" | "revoked"
  | "expired" | "requeued" | "executed" | "execution_halted" | "encumbered"
  | "encumbrance_released" | "spent" | "kill_rule_fired"
  | "circuit_breaker_tripped" | "emergency_stop" | "quote_refreshed";

export interface ApprovalEvent {
  id: string;
  approvalId: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: ApprovalEventAction;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  detail: Record<string, unknown> | null;
}

export interface ApprovalStore {
  create(a: Omit<MediaApproval, "id" | "createdAt" | "updatedAt">): Promise<MediaApproval>;
  get(id: string, workspaceId: string): Promise<MediaApproval | null>;
  update(id: string, workspaceId: string, patch: Partial<MediaApproval>): Promise<MediaApproval>;
  list(workspaceId: string, status?: ApprovalStatus, limit?: number): Promise<MediaApproval[]>;
  listPendingForClient(workspaceId: string, clientId: string): Promise<MediaApproval[]>;
  appendEvent(e: Omit<ApprovalEvent, "id" | "ts" | "prevHash" | "eventHash"> & { ts?: Date }): Promise<ApprovalEvent>;
  getEvents(approvalId: string, workspaceId: string, limit?: number): Promise<ApprovalEvent[]>;
  lastEventHash(approvalId: string, workspaceId: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Canonical JSON + binding hash
// ---------------------------------------------------------------------------

/** Stable stringify: sorted keys, recursive. The binding's fingerprint. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical binding JSON — the immutable approval token. */
export function bindingHashOf(binding: BuyBinding): string {
  return sha256Hex(canonicalize(binding));
}

/** Constant-time tamper check: does the live binding still match approval? */
export function verifyBinding(binding: BuyBinding, expectedHash: string): boolean {
  const actual = bindingHashOf(binding);
  return (
    actual.length === expectedHash.length &&
    // timingSafeEqual is imported via safety's re-export pattern — use crypto directly here
    safeEqHex(actual, expectedHash)
  );
}

function safeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Hash-chained event: event_hash = sha256(prev_hash || canonical payload). */
export function eventHashFor(prevHash: string, fields: {
  approvalId: string; ts: string; actor: string; action: string; payloadHash: string;
}): string {
  return sha256Hex(`${prevHash}|${canonicalize(fields)}`);
}

export class ApprovalViolationError extends SafetyViolationError {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalViolationError";
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CreateApprovalInput {
  workspaceId: string;
  clientId?: string;
  type: ApprovalType;
  binding: BuyBinding;
  poolId?: string;
  createdBy: string;
  createdByMediaRole: MediaRole;
}

export function validateBinding(binding: BuyBinding): void {
  if (!binding.platform?.trim()) throw new ApprovalViolationError("Binding requires a platform.");
  if (!binding.clientAdAccountId?.trim()) throw new ApprovalViolationError("Binding requires the client's own ad account id.");
  if (!Number.isInteger(binding.maxTotalSpendCents) || binding.maxTotalSpendCents <= 0) {
    throw new ApprovalViolationError("maxTotalSpendCents must be a positive integer.");
  }
  if (binding.lineItems.length === 0) throw new ApprovalViolationError("Binding requires at least one line item.");
  const sum = binding.lineItems.reduce((s, li) => s + li.maxAllowedCents, 0);
  if (sum > binding.maxTotalSpendCents) {
    throw new ApprovalViolationError("Line-item maxes exceed maxTotalSpendCents.");
  }
  for (const li of binding.lineItems) {
    if (li.creativeIds.length !== li.creativeHashes.length) {
      throw new ApprovalViolationError("creativeIds and creativeHashes must align per line item.");
    }
  }
  if (binding.dealType !== "auction" && !binding.quoteId) {
    throw new ApprovalViolationError("Direct deals (pd/pg/pa) require a quoteId (quote-then-book).");
  }
}

/** After approval, the binding is frozen — any edit attempt is rejected. */
export function assertBindingMutable(status: ApprovalStatus): void {
  if (status !== "draft") {
    throw new ApprovalViolationError(
      `Binding is immutable in status "${status}" — create a new approval version instead.`,
    );
  }
}

export async function logApprovalEvent(
  store: ApprovalStore,
  approvalId: string,
  workspaceId: string,
  actor: string,
  action: ApprovalEventAction,
  detail: Record<string, unknown> | null = null,
  ts: Date = new Date(),
): Promise<ApprovalEvent> {
  const payloadHash = sha256Hex(canonicalize(detail ?? {}));
  const prevHash = await store.lastEventHash(approvalId, workspaceId);
  return store.appendEvent({
    approvalId, workspaceId, actor, action, payloadHash, detail, ts,
  });
}

export async function createApproval(store: ApprovalStore, input: CreateApprovalInput): Promise<MediaApproval> {
  if (input.createdByMediaRole === "viewer") {
    throw new ApprovalViolationError("Viewers cannot propose media buys.");
  }
  validateBinding(input.binding);
  const bindingHash = bindingHashOf(input.binding);
  const approval = await store.create({
    workspaceId: input.workspaceId,
    clientId: input.clientId ?? null,
    type: input.type,
    status: "draft",
    binding: input.binding,
    bindingHash,
    maxSpendCents: input.binding.maxTotalSpendCents,
    currency: input.binding.currency.toUpperCase(),
    poolId: input.poolId ?? null,
    quoteId: input.binding.quoteId ?? null,
    quoteExpiresAt: input.binding.quoteExpiresAt ? new Date(input.binding.quoteExpiresAt) : null,
    driftTolerance: { ...input.binding.driftTolerance },
    createdBy: input.createdBy,
    approvers: [],
    twoPersonSatisfied: false,
    approvalMethod: "none",
    approvalReceipt: null,
    approvalsExpiresAt: null,
    approvedAt: null,
    revokedAt: null,
    revokedBy: null,
    executedAt: null,
  });
  await logApprovalEvent(store, approval.id, approval.workspaceId, input.createdBy, "created", {
    bindingHash, type: input.type,
  });
  return approval;
}

export async function submitApproval(
  store: ApprovalStore, id: string, workspaceId: string, actor: string,
): Promise<MediaApproval> {
  const a = await store.get(id, workspaceId);
  if (!a) throw new ApprovalViolationError("Approval not found in workspace.");
  assertApprovalTransition(a.status, "pending");
  const next = await store.update(id, workspaceId, { status: "pending" });
  await logApprovalEvent(store, id, workspaceId, actor, "submitted", { bindingHash: a.bindingHash });
  return next;
}

export interface ApproveInput {
  id: string;
  workspaceId: string;
  approverId: string;
  approverMediaRole: MediaRole;
  method: ApprovalMethod;
  /** Required for high-value buys (≥ two-person threshold): OTP challenge proof. */
  otpChallengeId?: string;
  otpCode?: string;
  otpStore?: OtpChallengeStore;
  twoPersonThresholdCents?: number;
  receiptSecret?: string;
  now?: Date;
  /** Wired by the route: encumber the pool on approval (S2 lifecycle). */
  onApproved?: (approval: MediaApproval) => Promise<{ alertsFired: number[] }>;
}

export async function approveApproval(store: ApprovalStore, input: ApproveInput): Promise<MediaApproval> {
  const now = input.now ?? new Date();
  assertCanApprove(input.approverMediaRole); // buyers propose but never approve
  const a = await store.get(input.id, input.workspaceId);
  if (!a) throw new ApprovalViolationError("Approval not found in workspace.");
  if (a.status !== "pending") {
    throw new ApprovalViolationError(`Only pending approvals can collect decisions (status: ${a.status}).`);
  }

  // Two-person, accumulated: hard violations throw; a short count keeps the
  // buy pending until the second approver decides (no silent auto-approval).
  const approverIds = [...a.approvers.map((r) => r.userId), input.approverId];
  const { satisfied, violations } = checkTwoPerson({
    creatorId: a.createdBy,
    approverIds,
    maxSpendCents: a.maxSpendCents,
    thresholdCents: input.twoPersonThresholdCents,
  });
  if (violations.length > 0) {
    await logApprovalEvent(store, a.id, a.workspaceId, input.approverId, "approval_rejected", {
      reason: "two_person_violation",
      detail: violations.join(" "),
    });
    throw new TwoPersonViolationError(violations.join(" "));
  }
  if (a.approvers.some((r) => r.userId === input.approverId)) {
    throw new ApprovalViolationError("Approver has already recorded a decision on this buy.");
  }

  // High-value buys: OTP/TOTP confirmation per approver → cryptographically
  // verified record.
  const highValue = a.maxSpendCents >= (input.twoPersonThresholdCents ?? 100_000);
  if (highValue) {
    if (input.method !== "otp" || !input.otpChallengeId || !input.otpCode || !input.otpStore) {
      throw new ApprovalViolationError(
        `High-value buy ($${(a.maxSpendCents / 100).toFixed(2)}): OTP confirmation required.`,
      );
    }
    if (!input.otpStore.verify(input.otpChallengeId, input.otpCode, now)) {
      await logApprovalEvent(store, a.id, a.workspaceId, input.approverId, "approval_rejected", {
        reason: "otp_failed",
      });
      throw new ApprovalViolationError("OTP verification failed — approval rejected and logged.");
    }
  }

  const decidedAt = now;
  const receipt = signApprovalReceipt({
    approvalId: a.id,
    bindingHash: a.bindingHash,
    approverId: input.approverId,
    decidedAt,
    secret: input.receiptSecret,
  });
  const record: ApproverRecord = {
    userId: input.approverId,
    decidedAt: decidedAt.toISOString(),
    method: input.method,
    receipt,
  };
  const approvers = [...a.approvers, record];

  if (!satisfied) {
    // First of two required decisions: record it, stay pending.
    const still = await store.update(input.id, input.workspaceId, { approvers });
    await logApprovalEvent(store, a.id, a.workspaceId, input.approverId, "approved", {
      method: input.method,
      approverCount: approvers.length,
      pendingSecondApprover: true,
      receipt,
    });
    return still;
  }

  assertApprovalTransition(a.status, "approved");
  const expiresAt = approvalsExpiresAt(decidedAt, executionWindowHours());

  const next = await store.update(input.id, input.workspaceId, {
    status: "approved",
    approvers,
    twoPersonSatisfied: true,
    approvalMethod: input.method,
    approvalReceipt: receipt,
    approvedAt: decidedAt,
    approvalsExpiresAt: expiresAt,
  });
  await logApprovalEvent(store, a.id, a.workspaceId, input.approverId, "approved", {
    method: input.method,
    approverCount: approvers.length,
    twoPersonSatisfied: true,
    receipt,
    expiresAt: expiresAt.toISOString(),
  });

  // S2 lifecycle: approval encumbers max_total_spend. If encumbrance fails
  // (over-encumbrance), the approval drops back to pending — the recorded
  // decisions stand, but money safety outranks approval state.
  if (input.onApproved) {
    try {
      const { alertsFired } = await input.onApproved(next);
      await logApprovalEvent(store, a.id, a.workspaceId, "system", "encumbered", {
        poolId: a.poolId, amountCents: a.maxSpendCents, alertsFired,
      });
    } catch (err) {
      await store.update(input.id, input.workspaceId, {
        status: "pending", twoPersonSatisfied: false,
        approvalMethod: "none", approvalReceipt: null, approvedAt: null, approvalsExpiresAt: null,
      });
      await logApprovalEvent(store, a.id, a.workspaceId, "system", "approval_rejected", {
        reason: "encumbrance_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
  return store.get(input.id, input.workspaceId) as Promise<MediaApproval>;
}

export async function revokeApproval(
  store: ApprovalStore, id: string, workspaceId: string, actor: string, actorMediaRole: MediaRole, reason: string,
  onRevoked?: (approval: MediaApproval) => Promise<void>,
): Promise<MediaApproval> {
  assertCanApprove(actorMediaRole);
  const a = await store.get(id, workspaceId);
  if (!a) throw new ApprovalViolationError("Approval not found in workspace.");
  assertApprovalTransition(a.status, "revoked");
  const next = await store.update(id, workspaceId, {
    status: "revoked", revokedAt: new Date(), revokedBy: actor,
  });
  await logApprovalEvent(store, id, workspaceId, actor, "revoked", { reason });
  // Revocation releases the encumbrance (S2 lifecycle).
  if (onRevoked) {
    await onRevoked(next);
    await logApprovalEvent(store, id, workspaceId, "system", "encumbrance_released", { reason: "revocation" });
  }
  return next;
}

/** Sweep helper: expire stale approvals (never execute expired — §9.4). */
export async function expireStaleApprovals(
  store: ApprovalStore,
  workspaceId: string,
  now: Date = new Date(),
  onExpired?: (approval: MediaApproval) => Promise<void>,
): Promise<string[]> {
  const expired: string[] = [];
  for (const a of await store.list(workspaceId, "approved", 500)) {
    if (isApprovalExpired(a.approvalsExpiresAt, now)) {
      await store.update(a.id, workspaceId, { status: "expired" });
      await logApprovalEvent(store, a.id, workspaceId, "system", "expired", {
        approvalsExpiresAt: a.approvalsExpiresAt?.toISOString() ?? null,
      });
      if (onExpired) await onExpired(a);
      expired.push(a.id);
    }
  }
  return expired;
}

/** Executor-only: verify the receipt chain before trusting the record. */
export function verifyApproverReceipts(approval: MediaApproval, secret?: string): boolean {
  if (approval.approvers.length === 0 || !approval.twoPersonSatisfied) return false;
  return approval.approvers.every((r) =>
    verifyApprovalReceipt(r.receipt, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      approverId: r.userId,
      decidedAt: new Date(r.decidedAt),
      secret,
    }),
  );
}

// ---------------------------------------------------------------------------
// In-memory store (tests / verify battery)
// ---------------------------------------------------------------------------

let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function createMemoryApprovalStore(): ApprovalStore {
  const approvals = new Map<string, MediaApproval>();
  const events: ApprovalEvent[] = [];
  const key = (id: string, workspaceId: string) => `${workspaceId}:${id}`;

  const chainHash = (approvalId: string, workspaceId: string) => {
    const mine = events.filter((e) => e.approvalId === approvalId && e.workspaceId === workspaceId);
    return mine.length ? mine[mine.length - 1].eventHash : "GENESIS";
  };

  return {
    async create(a) {
      const now = new Date();
      const row: MediaApproval = { ...a, id: uid("appr"), createdAt: now, updatedAt: now };
      approvals.set(key(row.id, row.workspaceId), row);
      return structuredClone(row);
    },
    async get(id, workspaceId) {
      const a = approvals.get(key(id, workspaceId));
      return a ? structuredClone(a) : null;
    },
    async update(id, workspaceId, patch) {
      const a = approvals.get(key(id, workspaceId));
      if (!a) throw new ApprovalViolationError("Approval not found in workspace.");
      const next = { ...structuredClone(a), ...structuredClone(patch), updatedAt: new Date() };
      approvals.set(key(id, workspaceId), next);
      return structuredClone(next);
    },
    async list(workspaceId, status, limit = 200) {
      return [...approvals.values()]
        .filter((a) => a.workspaceId === workspaceId && (!status || a.status === status))
        .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
        .slice(0, limit)
        .map((e) => structuredClone(e));
    },
    async listPendingForClient(workspaceId, clientId) {
      return [...approvals.values()]
        .filter((a) => a.workspaceId === workspaceId && a.clientId === clientId && a.status === "pending")
        .map((e) => structuredClone(e));
    },
    async appendEvent(e) {
      const ts = e.ts ?? new Date();
      const prevHash = chainHash(e.approvalId, e.workspaceId);
      const eventHash = eventHashFor(prevHash, {
        approvalId: e.approvalId, ts: ts.toISOString(), actor: e.actor,
        action: e.action, payloadHash: e.payloadHash,
      });
      const row: ApprovalEvent = { ...e, id: uid("aev"), ts, prevHash, eventHash };
      events.push(row);
      return structuredClone(row);
    },
    async getEvents(approvalId, workspaceId, limit = 500) {
      return events
        .filter((e) => e.approvalId === approvalId && e.workspaceId === workspaceId)
        .slice(-limit)
        .map((e) => structuredClone(e));
    },
    async lastEventHash(approvalId, workspaceId) {
      return chainHash(approvalId, workspaceId);
    },
  };
}

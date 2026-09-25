// Marketr — Phase 6 authority approvals: typed approval objects.
//
// Every external publishing action (outreach send, PR send, listing edit,
// review-reply post, AEO content fix, depth-3 activation) is approval-bound.
// The binding payload is canonicalized + hashed at creation; executors
// re-verify the exact payload before acting and HALT on mismatch.
// Two-person rule: depth3_activation and review_reply_post require two
// distinct approvers.
//
// Pure + synchronous (memory-store twin for batteries); the prisma store in
// lib/authority/db.ts implements the same interface.

import { createHash, createHmac } from "node:crypto";

export type AuthorityApprovalType =
  | "outreach_send"
  | "depth3_activation"
  | "pr_send"
  | "listing_edit"
  | "review_reply_post"
  | "aeo_content_fix";

export type AuthorityApprovalStatus =
  | "draft"
  | "pending"
  | "approved"
  | "approval_rejected"
  | "revoked"
  | "expired"
  | "executed";

/** Approval types that require two distinct human approvers. */
export const TWO_PERSON_TYPES: AuthorityApprovalType[] = ["depth3_activation", "review_reply_post"];

export interface ApprovalBinding {
  /** Stable payload describing exactly what is approved. */
  payload: Record<string, unknown>;
}

export interface AuthorityApproval {
  id: string;
  workspaceId: string;
  type: AuthorityApprovalType;
  status: AuthorityApprovalStatus;
  bindingJson: Record<string, unknown>;
  bindingHash: string;
  createdBy: string;
  approvers: string[];
  twoPersonRequired: boolean;
  approvalReceipt: string | null;
  decidedAt: Date | null;
  executedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ApprovalEvent {
  id: string;
  approvalId: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: string;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  detail?: Record<string, unknown> | null;
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

/** Canonical JSON: sorted keys, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function bindingHashOf(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalize(payload));
}

export function verifyBinding(approval: AuthorityApproval, payload: Record<string, unknown>): boolean {
  return approval.bindingHash === bindingHashOf(payload);
}

/** HMAC receipt: approval_secret, approvalId || bindingHash || approver || decidedAt. */
export function approvalReceiptFor(opts: {
  secret: string;
  approvalId: string;
  bindingHash: string;
  approver: string;
  decidedAt: Date;
}): string {
  const { secret, approvalId, bindingHash, approver, decidedAt } = opts;
  return createHmac("sha256", secret)
    .update(`${approvalId}||${bindingHash}||${approver}||${decidedAt.toISOString()}`, "utf8")
    .digest("hex");
}

export function eventHashFor(prevHash: string, approvalId: string, action: string, payloadHash: string, ts: Date): string {
  return sha256Hex(`${prevHash}||${approvalId}||${action}||${payloadHash}||${ts.toISOString()}`);
}

export interface AuthorityApprovalStore {
  create(input: {
    workspaceId: string;
    type: AuthorityApprovalType;
    bindingJson: Record<string, unknown>;
    createdBy: string;
    expiresAt?: Date | null;
  }): AuthorityApproval;
  get(id: string, workspaceId: string): AuthorityApproval | null;
  list(workspaceId: string, status?: AuthorityApprovalStatus, limit?: number): AuthorityApproval[];
  submit(id: string, workspaceId: string, actor: string): AuthorityApproval;
  approve(id: string, workspaceId: string, approver: string, secret: string): AuthorityApproval;
  reject(id: string, workspaceId: string, approver: string): AuthorityApproval;
  revoke(id: string, workspaceId: string, actor: string): AuthorityApproval;
  execute(id: string, workspaceId: string, payload: Record<string, unknown>): AuthorityApproval;
  expireStale(now?: Date): number;
  events(approvalId: string): ApprovalEvent[];
}

let idCounter = 0;
function cuid(prefix = "ap"): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryAuthorityApprovalStore(): AuthorityApprovalStore {
  const approvals = new Map<string, AuthorityApproval>();
  const events: ApprovalEvent[] = [];
  let lastHash = "GENESIS";

  function logEvent(approval: AuthorityApproval, actor: string, action: string, detail?: Record<string, unknown>): ApprovalEvent {
    const ts = new Date();
    const payloadHash = sha256Hex(canonicalize(detail ?? {}));
    const ev: ApprovalEvent = {
      id: cuid("ape"),
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      ts,
      actor,
      action,
      payloadHash,
      prevHash: lastHash,
      eventHash: eventHashFor(lastHash, approval.id, action, payloadHash, ts),
      detail: detail ?? null,
    };
    lastHash = ev.eventHash;
    events.push(ev);
    return ev;
  }

  function scoped(id: string, workspaceId: string): AuthorityApproval {
    const a = approvals.get(id);
    if (!a || a.workspaceId !== workspaceId) throw new ApprovalError("Approval not found in workspace.");
    return a;
  }

  return {
    create(input) {
      const twoPersonRequired = TWO_PERSON_TYPES.includes(input.type);
      const bindingHash = bindingHashOf(input.bindingJson);
      const a: AuthorityApproval = {
        id: cuid("ap"),
        workspaceId: input.workspaceId,
        type: input.type,
        status: "draft",
        bindingJson: input.bindingJson,
        bindingHash,
        createdBy: input.createdBy,
        approvers: [],
        twoPersonRequired,
        approvalReceipt: null,
        decidedAt: null,
        executedAt: null,
        revokedAt: null,
        revokedBy: null,
        expiresAt: input.expiresAt ?? null,
        createdAt: new Date(),
      };
      approvals.set(a.id, a);
      logEvent(a, input.createdBy, "created", { type: a.type, bindingHash });
      return a;
    },
    get(id, workspaceId) {
      const a = approvals.get(id);
      return a && a.workspaceId === workspaceId ? a : null;
    },
    list(workspaceId, status, limit = 100) {
      return [...approvals.values()]
        .filter((a) => a.workspaceId === workspaceId && (!status || a.status === status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },
    submit(id, workspaceId, actor) {
      const a = scoped(id, workspaceId);
      if (a.status !== "draft") throw new ApprovalError(`Cannot submit approval in status ${a.status}.`);
      a.status = "pending";
      logEvent(a, actor, "submitted");
      return a;
    },
    approve(id, workspaceId, approver, secret) {
      const a = scoped(id, workspaceId);
      if (a.status !== "pending") throw new ApprovalError(`Cannot approve approval in status ${a.status}.`);
      if (!a.approvers.includes(approver)) a.approvers.push(approver);
      if (a.twoPersonRequired && new Set(a.approvers).size < 2) {
        logEvent(a, approver, "approved_partial", { approvers: a.approvers.length });
        return a; // still pending — needs a second distinct approver
      }
      const decidedAt = new Date();
      a.status = "approved";
      a.decidedAt = decidedAt;
      a.approvalReceipt = approvalReceiptFor({
        secret,
        approvalId: a.id,
        bindingHash: a.bindingHash,
        approver,
        decidedAt,
      });
      logEvent(a, approver, "approved", { twoPerson: a.twoPersonRequired });
      return a;
    },
    reject(id, workspaceId, approver) {
      const a = scoped(id, workspaceId);
      if (a.status !== "pending") throw new ApprovalError(`Cannot reject approval in status ${a.status}.`);
      a.status = "approval_rejected";
      a.decidedAt = new Date();
      logEvent(a, approver, "approval_rejected");
      return a;
    },
    revoke(id, workspaceId, actor) {
      const a = scoped(id, workspaceId);
      if (a.status === "executed") throw new ApprovalError("Executed approvals cannot be revoked.");
      a.status = "revoked";
      a.revokedAt = new Date();
      a.revokedBy = actor;
      logEvent(a, actor, "revoked");
      return a;
    },
    execute(id, workspaceId, payload) {
      const a = scoped(id, workspaceId);
      if (a.status !== "approved") throw new ApprovalError(`Cannot execute approval in status ${a.status} — approval required.`);
      if (!verifyBinding(a, payload)) {
        logEvent(a, "executor", "execution_halted", { reason: "binding_mismatch" });
        throw new ApprovalError("Binding mismatch — execution HALTED. Payload does not match the approved binding.");
      }
      if (a.expiresAt && a.expiresAt.getTime() < Date.now()) {
        a.status = "expired";
        throw new ApprovalError("Approval expired — execution blocked.");
      }
      a.status = "executed";
      a.executedAt = new Date();
      logEvent(a, "executor", "executed", { bindingHash: a.bindingHash });
      return a;
    },
    expireStale(now = new Date()) {
      let n = 0;
      for (const a of approvals.values()) {
        if ((a.status === "draft" || a.status === "pending") && a.expiresAt && a.expiresAt.getTime() < now.getTime()) {
          a.status = "expired";
          logEvent(a, "system", "expired");
          n += 1;
        }
      }
      return n;
    },
    events(approvalId) {
      return events.filter((e) => e.approvalId === approvalId);
    },
  };
}

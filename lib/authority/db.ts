// Marketr — Phase 6 authority stores (prisma-backed).
//
// The Phase 6 models ARE merged into prisma/schema.prisma, so these stores
// use the typed generated client. All queries are workspace-scoped —
// cross-workspace access is rejected by the WHERE clause.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { createId } from "@/lib/media/ids";
import {
  type AuthorityApproval, type AuthorityApprovalStatus,
  type AuthorityApprovalType, bindingHashOf, eventHashFor, sha256Hex, canonicalize,
  ApprovalError,
} from "./approvals";
import {
  type AuthorityAuditEvent, type AuthorityAuditInput, type AuthorityAuditStore,
} from "./audit";
import { notifyApprovalDecided, notifyApprovalNeeded } from "@/lib/notifications/producers";

/** True when the Phase 6 authority tables exist (migrated). */
export async function authorityTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM authority_approvals LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authority approvals (async; the memory store in ./approvals.ts is the
// battery twin). Track builders use `authorityApprovals` below.
// ---------------------------------------------------------------------------

const TWO_PERSON: AuthorityApprovalType[] = ["depth3_activation", "review_reply_post"];

function jsonInput(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}

function toApproval(r: {
  id: string; workspaceId: string; type: string; status: string;
  bindingJson: unknown; bindingHash: string; createdBy: string;
  approversJson: unknown; twoPersonRequired: boolean; approvalReceipt: string | null;
  decidedAt: Date | null; executedAt: Date | null; revokedAt: Date | null;
  revokedBy: string | null; expiresAt: Date | null; createdAt: Date;
}): AuthorityApproval {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    type: r.type as AuthorityApprovalType,
    status: r.status as AuthorityApprovalStatus,
    bindingJson: (r.bindingJson ?? {}) as Record<string, unknown>,
    bindingHash: r.bindingHash,
    createdBy: r.createdBy,
    approvers: Array.isArray(r.approversJson) ? (r.approversJson as string[]) : [],
    twoPersonRequired: r.twoPersonRequired,
    approvalReceipt: r.approvalReceipt,
    decidedAt: r.decidedAt,
    executedAt: r.executedAt,
    revokedAt: r.revokedAt,
    revokedBy: r.revokedBy,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}

/** Async convenience wrapper — the interface track builders should use. */
export const authorityApprovals = {
  async create(input: { workspaceId: string; type: AuthorityApprovalType; bindingJson: Record<string, unknown>; createdBy: string; expiresAt?: Date | null }): Promise<AuthorityApproval> {
    const r = await prisma.authorityApproval.create({
      data: {
        id: createId(), workspaceId: input.workspaceId, type: input.type, status: "draft",
        bindingJson: jsonInput(input.bindingJson), bindingHash: bindingHashOf(input.bindingJson),
        createdBy: input.createdBy, approversJson: [], twoPersonRequired: TWO_PERSON.includes(input.type),
        expiresAt: input.expiresAt ?? null,
      },
    });
    const a = toApproval(r);
    await logApprovalEvent(a, input.createdBy, "created", { type: a.type, bindingHash: a.bindingHash });
    return a;
  },
  async get(id: string, workspaceId: string): Promise<AuthorityApproval | null> {
    const r = await prisma.authorityApproval.findFirst({ where: { id, workspaceId } });
    return r ? toApproval(r) : null;
  },
  async list(workspaceId: string, status?: AuthorityApprovalStatus, limit = 100): Promise<AuthorityApproval[]> {
    const rows = await prisma.authorityApproval.findMany({
      where: { workspaceId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: limit,
    });
    return rows.map(toApproval);
  },
  async submit(id: string, workspaceId: string, actor: string): Promise<AuthorityApproval> {
    const r = await scopedRow(id, workspaceId);
    if (r.status !== "draft") throw new ApprovalError(`Cannot submit approval in status ${r.status}.`);
    const updated = await prisma.authorityApproval.update({ where: { id }, data: { status: "pending" } });
    const a = toApproval(updated);
    await logApprovalEvent(a, actor, "submitted");
    // Phase 3 (J): best-effort "needs you" notification (never throws).
    await notifyApprovalNeeded({
      workspaceId,
      source: "authority",
      sourceId: a.id,
      title: a.type.replace(/_/g, " "),
      requestedBy: a.createdBy,
    });
    return a;
  },
  async approve(id: string, workspaceId: string, approver: string, secret: string): Promise<AuthorityApproval> {
    const r = await scopedRow(id, workspaceId);
    if (r.status !== "pending") throw new ApprovalError(`Cannot approve approval in status ${r.status}.`);
    const approvers = Array.isArray(r.approversJson) ? (r.approversJson as string[]) : [];
    if (!approvers.includes(approver)) approvers.push(approver);
    let a = toApproval({ ...r, approversJson: approvers });
    if (a.twoPersonRequired && new Set(approvers).size < 2) {
      await prisma.authorityApproval.update({ where: { id }, data: { approversJson: approvers } });
      await logApprovalEvent(a, approver, "approved_partial", { approvers: approvers.length });
      return { ...a, approvers };
    }
    const decidedAt = new Date();
    const { approvalReceiptFor } = await import("./approvals");
    const receipt = approvalReceiptFor({ secret, approvalId: id, bindingHash: r.bindingHash, approver, decidedAt });
    const updated = await prisma.authorityApproval.update({
      where: { id }, data: { approversJson: approvers, status: "approved", decidedAt, approvalReceipt: receipt },
    });
    a = toApproval(updated);
    await logApprovalEvent(a, approver, "approved", { twoPerson: a.twoPersonRequired });
    await notifyApprovalDecided({
      workspaceId,
      source: "authority",
      sourceId: a.id,
      title: a.type.replace(/_/g, " "),
      decision: "approved",
      decidedBy: approver,
      requestedBy: a.createdBy,
    });
    return a;
  },
  async reject(id: string, workspaceId: string, approver: string): Promise<AuthorityApproval> {
    const r = await scopedRow(id, workspaceId);
    if (r.status !== "pending") throw new ApprovalError(`Cannot reject approval in status ${r.status}.`);
    const updated = await prisma.authorityApproval.update({ where: { id }, data: { status: "approval_rejected", decidedAt: new Date() } });
    const a = toApproval(updated);
    await logApprovalEvent(a, approver, "approval_rejected");
    await notifyApprovalDecided({
      workspaceId,
      source: "authority",
      sourceId: a.id,
      title: a.type.replace(/_/g, " "),
      decision: "denied",
      decidedBy: approver,
      requestedBy: a.createdBy,
    });
    return a;
  },
  async revoke(id: string, workspaceId: string, actor: string): Promise<AuthorityApproval> {
    const r = await scopedRow(id, workspaceId);
    if (r.status === "executed") throw new ApprovalError("Executed approvals cannot be revoked.");
    const updated = await prisma.authorityApproval.update({ where: { id }, data: { status: "revoked", revokedAt: new Date(), revokedBy: actor } });
    const a = toApproval(updated);
    await logApprovalEvent(a, actor, "revoked");
    return a;
  },
  /** Executor entry point: re-verifies the exact binding before marking executed. */
  async execute(id: string, workspaceId: string, payload: Record<string, unknown>): Promise<AuthorityApproval> {
    const r = await scopedRow(id, workspaceId);
    if (r.status !== "approved") throw new ApprovalError(`Cannot execute approval in status ${r.status} — approval required.`);
    const a0 = toApproval(r);
    const { verifyBinding } = await import("./approvals");
    if (!verifyBinding(a0, payload)) {
      await logApprovalEvent(a0, "executor", "execution_halted", { reason: "binding_mismatch" });
      throw new ApprovalError("Binding mismatch — execution HALTED. Payload does not match the approved binding.");
    }
    if (r.expiresAt && r.expiresAt.getTime() < Date.now()) {
      await prisma.authorityApproval.update({ where: { id }, data: { status: "expired" } });
      throw new ApprovalError("Approval expired — execution blocked.");
    }
    const updated = await prisma.authorityApproval.update({ where: { id }, data: { status: "executed", executedAt: new Date() } });
    const a = toApproval(updated);
    await logApprovalEvent(a, "executor", "executed", { bindingHash: a.bindingHash });
    return a;
  },
};

async function scopedRow(id: string, workspaceId: string) {
  const r = await prisma.authorityApproval.findFirst({ where: { id, workspaceId } });
  if (!r) throw new ApprovalError("Approval not found in workspace.");
  return r;
}

async function logApprovalEvent(a: AuthorityApproval, actor: string, action: string, detail?: Record<string, unknown>) {
  const prev = await prisma.authorityApprovalEvent.findFirst({ where: { approvalId: a.id }, orderBy: { ts: "desc" } });
  const prevHash = prev?.eventHash ?? "GENESIS";
  const ts = new Date();
  const payloadHash = sha256Hex(canonicalize(detail ?? {}));
  await prisma.authorityApprovalEvent.create({
    data: {
      id: createId(), approvalId: a.id, workspaceId: a.workspaceId, ts, actor, action,
      payloadHash, prevHash, eventHash: eventHashFor(prevHash, a.id, action, payloadHash, ts),
      detail: detail === undefined ? undefined : jsonInput(detail),
    },
  });
}

// ---------------------------------------------------------------------------
// Authority audit (prisma)
// ---------------------------------------------------------------------------

export const authorityAudit: AuthorityAuditStore & {
  logAsync(input: AuthorityAuditInput): Promise<AuthorityAuditEvent>;
} = {
  log() { throw new ApprovalError("Use logAsync — prisma store is async."); },
  list() { throw new ApprovalError("Use listAsync — prisma store is async."); },
  verifyChain() { throw new ApprovalError("Chain verification runs on the memory store in batteries."); },
  async logAsync(input: AuthorityAuditInput): Promise<AuthorityAuditEvent> {
    const prev = await prisma.authorityAuditEvent.findFirst({ where: { workspaceId: input.workspaceId }, orderBy: { ts: "desc" } });
    const prevHash = prev?.eventHash ?? "GENESIS";
    const ts = new Date();
    const payloadHash = sha256Hex(canonicalize(input.detail ?? {}));
    const r = await prisma.authorityAuditEvent.create({
      data: {
        id: createId(), workspaceId: input.workspaceId, ts, actor: input.actor,
        action: input.action, entityType: input.entityType, entityId: input.entityId,
        payloadHash, prevHash, eventHash: eventHashFor(prevHash, input.entityId, input.action, payloadHash, ts),
        detail: input.detail == null ? undefined : jsonInput(input.detail),
      },
    });
    return {
      id: r.id, workspaceId: r.workspaceId, actor: r.actor, action: r.action,
      entityType: r.entityType, entityId: r.entityId, detail: (r.detail ?? null) as Record<string, unknown> | null,
      ts: r.ts, payloadHash: r.payloadHash, prevHash: r.prevHash, eventHash: r.eventHash,
    };
  },
};

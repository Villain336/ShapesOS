// Marketr — Phase 9 M6: approval decide logic (SPEC-PHASE9.md §P9E).
//
// Shared by POST /api/automation/decide (and M4's
// POST /api/missions/:id/approvals/:approvalId/decide, which must keep this
// contract exactly: body { decision }, decision ∈ {approved, denied}).
// Deciding writes a hash-chained event to `mission_approval_events`
// (M1 gap #2): per-approval chain, prev_hash = previous eventHash for this
// approval ("GENESIS" for the first).

import { withWorkspaceScope, type TxClient } from "../substrate/graph/rls";
import { canonicalize, eventHashFor, sha256Hex } from "../authority/approvals";
import { notifyApprovalDecided } from "../notifications/producers";

export type ApprovalDecision = "approved" | "denied";

/** Normalize the client's decision string; null when invalid. */
export function normalizeDecision(value: unknown): ApprovalDecision | null {
  if (value === "approved" || value === "approve") return "approved";
  if (value === "denied" || value === "deny" || value === "rejected") return "denied";
  return null;
}

export interface DecideInput {
  approvalId: string;
  /** When given, the approval must belong to this mission. */
  missionId?: string | null;
  decision: ApprovalDecision;
  actor: string;
}

export interface DecideOutcome {
  approvalId: string;
  missionId: string | null;
  status: "approved" | "denied";
  decidedAt: Date;
  eventId: string;
  eventHash: string;
  /** Who requested it + what (for the decided notification). */
  requestedBy?: string;
  action?: string;
}

export class DecideError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DecideError";
  }
}

/**
 * Append one hash-chained event to mission_approval_events.
 * prevHash = previous eventHash for this approvalId ("GENESIS" first).
 */
export async function appendApprovalEvent(
  tx: TxClient,
  input: {
    approvalId: string;
    workspaceId: string;
    actor: string;
    action: string;
    detail: Record<string, unknown>;
  },
): Promise<{ id: string; eventHash: string; prevHash: string }> {
  const last = await tx.missionApprovalEvent.findFirst({
    where: { approvalId: input.approvalId, workspaceId: input.workspaceId },
    orderBy: { ts: "desc" },
    select: { eventHash: true },
  });
  const prevHash = last?.eventHash ?? "GENESIS";
  const ts = new Date();
  const payloadHash = sha256Hex(canonicalize(input.detail));
  const eventHash = eventHashFor(prevHash, input.approvalId, input.action, payloadHash, ts);
  const row = await tx.missionApprovalEvent.create({
    data: {
      approvalId: input.approvalId,
      workspaceId: input.workspaceId,
      ts,
      actor: input.actor,
      action: input.action,
      payloadHash,
      prevHash,
      eventHash,
    },
    select: { id: true },
  });
  return { id: row.id, eventHash, prevHash };
}

/**
 * decideApprovalTx — run inside a tenant-scoped transaction. Transitions a
 * pending MissionApproval to approved|denied and appends the hash-chained
 * decide event. Throws DecideError with an HTTP status on any violation.
 */
export async function decideApprovalTx(
  tx: TxClient,
  input: DecideInput & { workspaceId: string },
): Promise<DecideOutcome> {
  const { approvalId, workspaceId, missionId, decision, actor } = input;
  if (!approvalId || typeof approvalId !== "string") {
    throw new DecideError("approvalId is required.", 400);
  }
  const approval = await tx.missionApproval.findFirst({
    where: { id: approvalId, workspaceId },
    select: {
      id: true,
      missionId: true,
      status: true,
      expiresAt: true,
      decidedBy: true,
      createdBy: true,
      action: true,
    },
  });
  if (!approval) throw new DecideError("Approval not found in this workspace.", 404);
  if (missionId && approval.missionId !== missionId) {
    throw new DecideError("Approval does not belong to this mission.", 400);
  }
  if (approval.status !== "pending") {
    throw new DecideError(
      `Approval is already ${approval.status} — only pending approvals can be decided.`,
      409,
    );
  }
  if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
    await tx.missionApproval.update({
      where: { id: approval.id, workspaceId },
      data: { status: "expired" },
    });
    await appendApprovalEvent(tx, {
      approvalId: approval.id,
      workspaceId,
      actor: "system",
      action: "expired",
      detail: { reason: "expired_at_decide_time" },
    });
    throw new DecideError("Approval expired before it could be decided.", 410);
  }

  const decidedAt = new Date();
  await tx.missionApproval.update({
    where: { id: approval.id, workspaceId },
    data: { status: decision, decidedBy: actor, decidedAt },
  });
  const event = await appendApprovalEvent(tx, {
    approvalId: approval.id,
    workspaceId,
    actor,
    action: decision === "approved" ? "approved" : "denied",
    detail: { decidedBy: actor, decidedAt: decidedAt.toISOString(), decision },
  });
  return {
    approvalId: approval.id,
    missionId: approval.missionId,
    status: decision,
    decidedAt,
    eventId: event.id,
    eventHash: event.eventHash,
    requestedBy: approval.createdBy,
    action: approval.action,
  };
}

/** DB-backed wrapper: tenant-scoped transaction + workspace filter. */
export async function decideApproval(
  workspaceId: string,
  input: DecideInput,
): Promise<DecideOutcome> {
  const outcome = await withWorkspaceScope(workspaceId, (tx) =>
    decideApprovalTx(tx, { ...input, workspaceId }),
  );
  // Phase 3 (J): tell the requester (best-effort, after the commit).
  await notifyApprovalDecided({
    workspaceId,
    source: "mission",
    sourceId: outcome.approvalId,
    title: (outcome.action ?? "Mission action").replace(/[_.]+/g, " "),
    decision: outcome.status,
    decidedBy: input.actor,
    requestedBy: outcome.requestedBy ?? null,
    href: outcome.missionId ? `/dashboard/missions/${encodeURIComponent(outcome.missionId)}` : undefined,
  });
  return outcome;
}

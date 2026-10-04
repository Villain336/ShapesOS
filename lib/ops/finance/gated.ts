// ShapesOS — Phase 10 (finance): one gated-write helper for the finance
// routes that aren't plain entity PATCHes (credit notes, bill payments,
// expense approvals, reversals). Same doctrine as lib/ops/doctype.ts:
//   no approvalId → propose a Phase 14 approval (audit gate_proposed) and
//                   return approval_required — nothing is written;
//   approvalId    → verify (fail-closed: missing / pending / expired /
//                   binding-mismatched) and claim it approved → executed IN
//                   THIS TRANSACTION, then run the write. A failed write rolls
//                   the claim back, so the approval is not burned.

import type { Prisma } from "@prisma/client";
import type { OpsActor } from "../doctype";
import {
  phase14GatePort,
  requestOpsApproval,
  verifyAndConsumeOpsApproval,
  type OpsGatePort,
  type OpsGateProposal,
} from "../gate";

type Tx = Prisma.TransactionClient;

export type GatedResult<T> =
  | { outcome: "approval_required"; approval: OpsGateProposal }
  | { outcome: "done"; result: T };

export interface GatedSpec {
  slug: string;
  /** Entity slug the approval binds to (e.g. "invoices"). */
  entity: string;
  entityId?: string;
  /** The exact mutation the approval covers (canonical-JSON compared). */
  mutation: Record<string, unknown>;
  /** Plain-language summary for the approver. */
  summary: string;
  approvalId?: string | null;
  gatePort?: OpsGatePort;
}

export async function runGated<T>(
  tx: Tx,
  actor: OpsActor,
  spec: GatedSpec,
  execute: () => Promise<T>,
): Promise<GatedResult<T>> {
  const port = spec.gatePort ?? phase14GatePort;
  const audit = (action: string, summary: string) =>
    tx.opsAuditEvent.create({
      data: {
        workspaceId: actor.workspaceId,
        entity: spec.entity,
        entityId: spec.entityId ?? null,
        action,
        actor: actor.userId,
        summary: summary.slice(0, 2000),
      },
    });
  if (!spec.approvalId) {
    const approval = await requestOpsApproval(port, {
      workspaceId: actor.workspaceId,
      slug: spec.slug,
      entity: spec.entity,
      entityId: spec.entityId,
      mutation: spec.mutation,
      actor: actor.userId,
      summary: spec.summary,
    });
    await audit("gate_proposed", `${spec.slug} proposed (approval ${approval.id}): ${spec.summary}`);
    return { outcome: "approval_required", approval };
  }
  await verifyAndConsumeOpsApproval(port, tx, {
    workspaceId: actor.workspaceId,
    slug: spec.slug,
    entity: spec.entity,
    entityId: spec.entityId,
    mutation: spec.mutation,
    approvalId: spec.approvalId,
    actor: actor.userId,
  });
  const result = await execute();
  await audit("gate_executed", `${spec.slug} (approval ${spec.approvalId}): ${spec.summary}`);
  return { outcome: "done", result };
}

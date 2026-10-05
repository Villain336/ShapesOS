// ShapesOS — Phase 9 (sites): one-click rollback of a hosting deployment.
//
// A rollback makes an earlier deployment live again (Vercel instant
// rollback, Cloudflare Pages rollback, Netlify restore). It changes a live
// site, so it is a Tier-2 action: it ALWAYS goes through the existing
// approval gate (the Phase 14 gate in lib/integrations/actions/gate.ts —
// the same queue, "needs you" inbox and audit trail the Operations gate
// uses), never straight from the button:
//
//   1. the button posts without an approval → proposeAction() stores a
//      pending approval (appKey "hosting") bound to EXACTLY this rollback
//      (site, Deployment row, connection, provider deployment id) → 202;
//   2. a person approves it in Actions (separation of duties applies);
//   3. the button posts again with the approval id → verified (approved,
//      unexpired, canonical binding match) → claimed approved → executed
//      (the replay lock, consumeOpsApproval) → the provider rollback runs.
//      A provider failure re-arms the approval (executed → approved, with an
//      audit entry) so the same approval can be retried.

import type { Prisma } from "@prisma/client";
import { canonicalize } from "@/lib/authority/approvals";
import { consumeOpsApproval, phase14GatePort, type OpsGateApproval } from "@/lib/ops/gate";
import { NotFoundError } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { DeployPlace, DeployTarget, DeploymentSummary } from "./types";

export const ROLLBACK_APP_KEY = "hosting";
export const ROLLBACK_TOOL = "HOSTING_DEPLOY_ROLLBACK";

/** What one approval covers — nothing else can be executed under it. */
export interface RollbackBinding {
  action: typeof ROLLBACK_TOOL;
  siteId: string;
  /** Our Deployment row being restored. */
  deploymentRecordId: string;
  connectionId: string;
  target: string;
  /** The provider's deployment id. */
  providerDeploymentId: string;
  [key: string]: unknown;
}

export function rollbackBinding(dep: {
  id: string;
  siteId: string;
  connectionId: string | null;
  target: string;
  deploymentId: string | null;
}): RollbackBinding {
  return {
    action: ROLLBACK_TOOL,
    siteId: dep.siteId,
    deploymentRecordId: dep.id,
    connectionId: dep.connectionId ?? "",
    target: String(dep.target),
    providerDeploymentId: dep.deploymentId ?? "",
  };
}

export class RollbackError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RollbackError";
  }
}

// ---------------------------------------------------------------------------
// Which rows can be rolled back to (PURE).
// ---------------------------------------------------------------------------

export interface DeploymentRowLite {
  id: string;
  connectionId: string | null;
  providerProject: string | null;
  deploymentId: string | null;
  status: string;
  createdAt: Date;
}

export interface RollbackEligibility {
  /** Its provider deployment is what this site's connection serves now. */
  current: boolean;
  canRollBack: boolean;
  reason: string | null;
}

/**
 * Every row of ONE site gets a verdict. "Live" is tracked per hosting
 * connection (a site deploys to one provider project per connection).
 */
export function rollbackEligibility(rows: DeploymentRowLite[]): Map<string, RollbackEligibility> {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // What is live per place: the newest ready row's provider deployment (a
  // rollback row repeats the restored deployment's id, so both read live).
  const live = new Map<string, string | null>();
  for (const r of sorted) {
    const place = r.connectionId ?? "";
    if (r.status === "ready" && !live.has(place)) live.set(place, r.deploymentId);
  }
  const out = new Map<string, RollbackEligibility>();
  for (const r of sorted) {
    const place = r.connectionId ?? "";
    const ready = r.status === "ready";
    const current = ready && live.has(place) && live.get(place) === r.deploymentId;
    let reason: string | null = null;
    if (!r.connectionId) reason = "Its hosting connection was removed.";
    else if (!r.deploymentId) reason = "The provider did not return a deployment id.";
    else if (!ready) reason = "Only a finished (ready) deployment can be restored.";
    else if (current) reason = "This is the live deployment.";
    out.set(r.id, { current, canRollBack: reason === null, reason });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate port (the Phase 14 gate; tests swap in a fake).
// ---------------------------------------------------------------------------

export interface RollbackApproval extends OpsGateApproval {}

export interface RollbackGatePort {
  propose(input: { workspaceId: string; binding: RollbackBinding; actor: string; summary: string }): Promise<{
    id: string;
    status: string;
    riskTier: string;
  }>;
  getApproval(workspaceId: string, id: string): Promise<RollbackApproval>;
  /** approved → executed, atomically (replay lock). Throws when it loses. */
  claim(workspaceId: string, approval: RollbackApproval, actor: string): Promise<void>;
  /** executed → approved after a failed provider call (retry allowed). */
  release(workspaceId: string, approvalId: string, actor: string, detail: string): Promise<void>;
}

export const phase14RollbackPort: RollbackGatePort = {
  propose: ({ workspaceId, binding, actor, summary }) =>
    phase14GatePort.propose({
      workspaceId,
      appKey: ROLLBACK_APP_KEY,
      toolName: ROLLBACK_TOOL,
      args: binding,
      proposedBy: actor,
      plainSummary: summary,
    }),
  getApproval: (workspaceId, id) => phase14GatePort.getApproval(workspaceId, id),
  claim: (workspaceId, approval, actor) =>
    withWorkspaceScope(workspaceId, (tx) => consumeOpsApproval(tx, { workspaceId, approval, actor, slug: ROLLBACK_TOOL })),
  release: (workspaceId, approvalId, actor, detail) =>
    withWorkspaceScope(workspaceId, async (tx) => {
      const row = await tx.composioActionApproval.findFirst({ where: { id: approvalId, workspaceId }, select: { auditTrail: true } });
      const prior = Array.isArray(row?.auditTrail) ? (row!.auditTrail as unknown[]) : [];
      await tx.composioActionApproval.updateMany({
        where: { id: approvalId, workspaceId, status: "executed" },
        data: {
          status: "approved",
          auditTrail: [
            ...prior,
            { at: new Date().toISOString(), actor, event: "execution_failed", detail: detail.slice(0, 300) },
          ] as unknown as Prisma.InputJsonValue,
        },
      });
    }),
};

/** Propose the rollback for review (step 1). */
export async function requestRollback(
  port: RollbackGatePort,
  input: { workspaceId: string; binding: RollbackBinding; actor: string; summary: string },
) {
  if (!input.binding.connectionId || !input.binding.providerDeploymentId) {
    throw new RollbackError("not_restorable", "This deployment can't be restored.", 409);
  }
  return port.propose(input);
}

/** Check an approval covers exactly this rollback (fail-closed). */
export async function verifyRollbackApproval(
  port: RollbackGatePort,
  input: { workspaceId: string; binding: RollbackBinding; approvalId: string },
  now = new Date(),
): Promise<RollbackApproval> {
  let approval: RollbackApproval;
  try {
    approval = await port.getApproval(input.workspaceId, input.approvalId);
  } catch (err) {
    if (err instanceof NotFoundError) throw new RollbackError("approval_not_found", "Approval not found.", 404);
    throw err;
  }
  if (approval.status === "executed") throw new RollbackError("approval_replayed", "This approval was already used.", 409);
  if (approval.status === "pending") throw new RollbackError("approval_pending", "Waiting for approval in Actions.", 409);
  if (approval.status !== "approved") {
    throw new RollbackError("approval_not_approved", `The approval is ${approval.status}.`, 409);
  }
  if (approval.expiresAt.getTime() < now.getTime()) throw new RollbackError("approval_expired", "The approval expired.", 409);
  const expected = canonicalize(input.binding);
  const actual = canonicalize((approval.proposedArgs ?? {}) as Record<string, unknown>);
  if (expected !== actual) {
    throw new RollbackError("binding_mismatch", "That approval is for a different rollback.", 409);
  }
  return approval;
}

/** Steps 3: verify → claim → provider rollback (→ release on failure). */
export async function executeRollback(
  port: RollbackGatePort,
  input: {
    workspaceId: string;
    binding: RollbackBinding;
    approvalId: string;
    actor: string;
    target: DeployTarget;
    place: DeployPlace;
  },
): Promise<{ result: DeploymentSummary; approval: RollbackApproval }> {
  const approval = await verifyRollbackApproval(port, input);
  try {
    await port.claim(input.workspaceId, approval, input.actor);
  } catch {
    throw new RollbackError("approval_replayed", "This approval was already used.", 409);
  }
  try {
    const result = await input.target.rollback(input.binding.providerDeploymentId, input.place);
    return { result, approval };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Rollback failed";
    await port.release(input.workspaceId, approval.id, input.actor, msg).catch(() => undefined);
    throw new RollbackError("provider_failed", msg, 502);
  }
}

/** Who approved it: the actor of the trail's "approved" event. */
export function approverOf(auditTrail: unknown): string | null {
  const arr = Array.isArray(auditTrail) ? (auditTrail as Array<{ event?: unknown; actor?: unknown }>) : [];
  const e = [...arr].reverse().find((x) => x?.event === "approved");
  return typeof e?.actor === "string" ? e.actor : null;
}

/** Open rollback approvals of a site, keyed by Deployment row id. */
export async function openRollbackApprovals(
  workspaceId: string,
  siteId: string,
): Promise<Map<string, { approvalId: string; status: string }>> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioActionApproval.findMany({
      where: {
        workspaceId,
        appKey: ROLLBACK_APP_KEY,
        toolName: ROLLBACK_TOOL,
        status: { in: ["pending", "approved"] },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, status: true, proposedArgs: true },
    }),
  );
  const out = new Map<string, { approvalId: string; status: string }>();
  for (const r of rows) {
    const b = (r.proposedArgs ?? {}) as Partial<RollbackBinding>;
    if (b.siteId !== siteId || typeof b.deploymentRecordId !== "string") continue;
    if (!out.has(b.deploymentRecordId)) out.set(b.deploymentRecordId, { approvalId: r.id, status: r.status });
  }
  return out;
}

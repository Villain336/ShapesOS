// ShapesOS — Phase 21A round 2 (WS=agentweb): delegation records (agentweb_delegations,
// FORCE RLS). One row per authorised agent web action: who delegated it, the scope, the
// run, when the delegation expires, the tier decision, and the receipt it belongs to. The
// same facts ride in the audit chain entry of the step (lib/agentweb/receipts.ts).

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { DelegationRecord } from "../receipts";

type Tx = Prisma.TransactionClient;

/** How long a delegation lasts when nothing ends it sooner: until the task goes idle (5 minutes). */
export const DELEGATION_IDLE_MS = 5 * 60_000;

export async function storeDelegation(workspaceId: string, d: DelegationRecord): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebDelegation.create({
      data: {
        id: d.id,
        workspaceId,
        runId: d.runId ?? null,
        delegatedBy: d.delegatedBy,
        agent: d.agent,
        scope: d.scope as unknown as Prisma.InputJsonValue,
        expiresAt: d.expiresAt,
        action: d.action.slice(0, 24),
        url: d.url,
        origin: d.origin,
        tier: d.tier,
        decision: d.decision.slice(0, 16),
        reason: d.reason,
        captureId: d.captureId,
        auditEventId: d.auditEventId,
      },
    }),
  );
}

export interface DelegationView {
  id: string;
  runId: string | null;
  delegatedBy: string;
  agent: string;
  scope: { origins: string[]; classes: string[] };
  expiresAt: string;
  action: string;
  origin: string;
  tier: number;
  decision: string;
  captureId: string | null;
  createdAt: string;
}

const view = (r: { id: string; runId: string | null; delegatedBy: string; agent: string; scope: unknown; expiresAt: Date; action: string; origin: string; tier: number; decision: string; captureId: string | null; createdAt: Date }): DelegationView => ({
  id: r.id,
  runId: r.runId,
  delegatedBy: r.delegatedBy,
  agent: r.agent,
  scope: r.scope as DelegationView["scope"],
  expiresAt: r.expiresAt.toISOString(),
  action: r.action,
  origin: r.origin,
  tier: r.tier,
  decision: r.decision,
  captureId: r.captureId,
  createdAt: r.createdAt.toISOString(),
});

/** The delegation behind one receipt, if the action was recorded with one. */
export async function delegationForCapture(workspaceId: string, captureId: string): Promise<DelegationView | null> {
  const r = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebDelegation.findFirst({ where: { workspaceId, captureId } }));
  return r ? view(r) : null;
}

export async function listDelegations(workspaceId: string, opts: { runId?: string; limit?: number } = {}): Promise<DelegationView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebDelegation.findMany({ where: { workspaceId, ...(opts.runId ? { runId: opts.runId } : {}) }, orderBy: { createdAt: "asc" }, take: Math.min(opts.limit ?? 200, 500) }),
  );
  return rows.map(view);
}

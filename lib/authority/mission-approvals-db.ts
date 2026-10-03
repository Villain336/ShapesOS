// Marketr — Phase 9 M2: Prisma-backed MissionApprovalStore (M1 gap #1).
//
// Implements the same MissionApprovalStore interface as the memory twin in
// lib/authority/executor.ts. Tenant isolation is two-layer:
//   1. withWorkspaceScope() pins the app.workspace_id GUC per transaction
//      (FORCE RLS, fail-closed — sessions without the GUC see zero rows);
//   2. every read/write ALSO carries `where: { workspaceId }` (defense in depth).
//
// The scope runner is injectable so the mapping logic is unit-testable
// without a database (tests pass a fake tx).
//
// Known divergences from the memory twin (documented, not hidden):
//   - expiresAt: the Prisma column is NOT NULL, so a missing/null expiresAt
//     defaults to now + 24h (the memory twin stores null).
//   - appendEvent: executor chain events persist into the append-only
//     mission_events trail with step "approval.<approvalId>.<action>"; the
//     per-approval chain head is reconstructed from that trail
//     (prevHash = last eventHash for the approval, else "GENESIS").
//     Approvals with a NULL missionId cannot be chain-logged (mission_events
//     requires a mission) — appendEvent throws ApprovalError for those.
//     get/create/setStatus work fine without a mission.

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import {
  ApprovalError,
  bindingHashOf,
  canonicalize,
  eventHashFor,
  sha256Hex,
} from "./approvals";
import type {
  ExecutorChainEvent,
  MissionApprovalStatusName,
  MissionApprovalStore,
  StoredMissionApproval,
} from "./executor";

/** Minimal tx surface this store needs (real Prisma tx or a test fake). */
export interface ApprovalTx {
  missionApproval: {
    create(args: { data: Record<string, unknown> }): Promise<ApprovalRow>;
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<ApprovalRow | null>;
    update(args: {
      where: { id: string; workspaceId: string };
      data: Record<string, unknown>;
    }): Promise<ApprovalRow>;
  };
  missionEvent: {
    findFirst(args: {
      where: { missionId: string; workspaceId: string; step: { startsWith: string } };
      orderBy: { ts: "desc" };
      select: { eventHash: true };
    }): Promise<{ eventHash: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

/** Prisma row shape (subset). */
export interface ApprovalRow {
  id: string;
  workspaceId: string;
  missionId: string | null;
  action: string;
  tier: number;
  bindingJson: unknown;
  bindingHash: string;
  status: string;
  expiresAt: Date;
  decidedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export type ScopeRunner = <T>(
  workspaceId: string,
  fn: (tx: ApprovalTx) => Promise<T>,
) => Promise<T>;

const DEFAULT_APPROVAL_TTL_MS = 24 * 3_600_000; // 24h — Prisma expiresAt is NOT NULL

function toStored(a: ApprovalRow): StoredMissionApproval {
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    missionId: a.missionId,
    action: a.action,
    tier: a.tier,
    bindingJson: (a.bindingJson ?? {}) as Record<string, unknown>,
    bindingHash: a.bindingHash,
    status: a.status as MissionApprovalStatusName,
    expiresAt: a.expiresAt,
    decidedAt: a.decidedAt,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
  };
}

/** Step prefix for executor chain events in the mission_events trail. */
function chainStepPrefix(approvalId: string): string {
  return `approval.${approvalId}.`;
}

export function createPrismaMissionApprovalStore(
  scope: ScopeRunner = (workspaceId, fn) =>
    // The real Prisma tx client structurally satisfies the minimal ApprovalTx
    // surface (create/findFirst/update on missionApproval); the double cast
    // keeps the store testable against fakes while running on the real client.
    withWorkspaceScope(workspaceId, (tx) => fn(tx as unknown as ApprovalTx)),
): MissionApprovalStore {
  /** Fetch the approval or throw — always workspace-scoped (defense in depth). */
  async function scoped(
    tx: ApprovalTx,
    approvalId: string,
    workspaceId: string,
  ): Promise<ApprovalRow> {
    const row = await tx.missionApproval.findFirst({
      where: { id: approvalId, workspaceId },
    });
    if (!row) throw new ApprovalError("Approval not found in workspace.");
    return row;
  }

  return {
    async get(approvalId, workspaceId) {
      return scope(workspaceId, async (tx) => {
        const row = await tx.missionApproval.findFirst({
          where: { id: approvalId, workspaceId },
        });
        return row ? toStored(row) : null;
      });
    },

    async create(input) {
      return scope(input.workspaceId, async (tx) => {
        const row = await tx.missionApproval.create({
          data: {
            workspaceId: input.workspaceId,
            missionId: input.missionId ?? null,
            action: input.action,
            tier: input.tier,
            bindingJson: input.bindingJson,
            bindingHash: bindingHashOf(input.bindingJson),
            // Prisma expiresAt is NOT NULL — default 24h when unspecified.
            expiresAt: input.expiresAt ?? new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS),
            createdBy: input.createdBy,
          },
        });
        return toStored(row);
      });
    },

    async setStatus(approvalId, workspaceId, status, patch) {
      return scope(workspaceId, async (tx) => {
        const row = await scoped(tx, approvalId, workspaceId);
        const updated = await tx.missionApproval.update({
          where: { id: row.id, workspaceId },
          data: {
            status,
            ...(patch?.decidedAt ? { decidedAt: patch.decidedAt } : {}),
          },
        });
        return toStored(updated);
      });
    },

    async appendEvent(approvalId, workspaceId, actor, action, detail) {
      return scope(workspaceId, async (tx) => {
        const row = await scoped(tx, approvalId, workspaceId);
        if (!row.missionId) {
          throw new ApprovalError(
            "Approval has no mission — executor chain events require a mission-scoped trail. " +
              "Bind the approval to a mission, or use the memory store for standalone approvals.",
          );
        }
        const prefix = chainStepPrefix(row.id);
        const prev = await tx.missionEvent.findFirst({
          where: {
            missionId: row.missionId,
            workspaceId,
            step: { startsWith: prefix },
          },
          orderBy: { ts: "desc" },
          select: { eventHash: true },
        });
        const prevHash = prev?.eventHash ?? "GENESIS";
        const ts = new Date();
        const payloadHash = sha256Hex(canonicalize(detail));
        const eventHash = eventHashFor(prevHash, row.id, action, payloadHash, ts);
        await tx.missionEvent.create({
          data: {
            missionId: row.missionId,
            workspaceId,
            ts,
            actor,
            step: `${prefix}${action}`,
            observation: detail,
            costCents: 0,
            eventHash,
            prevHash,
          },
        });
        const ev: ExecutorChainEvent = {
          approvalId: row.id,
          workspaceId,
          ts,
          actor,
          action,
          payloadHash,
          prevHash,
          eventHash,
          detail,
        };
        return ev;
      });
    },
  };
}

// Marketr — Phase 9 M4: Prisma-backed MissionStore (docs/specs/SPEC-PHASE9.md §P9C).
//
// API-layer only — this module uses the @/ alias and the generated Prisma
// client, so it is NOT imported by lib/missions/engine.ts or the tsx tests.
// All tenant-scoped ops go through withWorkspaceScope (tenant GUC pinned per
// transaction, fail-closed RLS) PLUS where: { workspaceId } defense in depth.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { appendMissionEvent } from "@/lib/orchestrator/audit";
import { bindingHashOf } from "@/lib/authority/approvals";
import { createId } from "@/lib/media/ids";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";
import type {
  AppendEventInput,
  CreateApprovalInput,
  CreateMissionInput,
  MissionStore,
  StoredMission,
  StoredMissionApproval,
  StoredMissionEvent,
  UpdateMissionPatch,
} from "./store";
import type {
  ApprovalStatusName,
  CheckpointRecord,
  MissionStatusName,
  TerminationConfig,
} from "./types";

function jsonInput(v: unknown): Prisma.InputJsonValue {
  return v as Prisma.InputJsonValue;
}
function jsonOut(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

type MissionRow = {
  id: string;
  workspaceId: string;
  template: string;
  goal: unknown;
  status: string;
  planSnapshot: unknown;
  checkpoints: unknown;
  budgetCaps: unknown;
  termination: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

function toMission(r: MissionRow): StoredMission {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    template: r.template,
    goal: jsonOut(r.goal),
    status: r.status as MissionStatusName,
    planSnapshot: jsonOut(r.planSnapshot),
    checkpoints: (Array.isArray(r.checkpoints) ? r.checkpoints : []) as CheckpointRecord[],
    budgetCaps: jsonOut(r.budgetCaps),
    termination: r.termination as TerminationConfig,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type MissionEventRow = {
  id: string;
  missionId: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  step: string | null;
  tool: string | null;
  args: unknown;
  observation: unknown;
  costCents: number;
  eventHash: string;
  prevHash: string;
};

function toEvent(r: MissionEventRow): StoredMissionEvent {
  return {
    id: r.id,
    missionId: r.missionId,
    workspaceId: r.workspaceId,
    ts: r.ts,
    actor: r.actor,
    step: r.step,
    tool: r.tool,
    args: jsonOut(r.args),
    observation: jsonOut(r.observation),
    costCents: r.costCents,
    eventHash: r.eventHash,
    prevHash: r.prevHash,
  };
}

type MissionApprovalRow = {
  id: string;
  workspaceId: string;
  missionId: string | null;
  action: string;
  tier: number;
  bindingJson: unknown;
  bindingHash: string;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
};

function toApproval(r: MissionApprovalRow): StoredMissionApproval {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    missionId: r.missionId,
    action: r.action,
    tier: r.tier,
    bindingJson: jsonOut(r.bindingJson),
    bindingHash: r.bindingHash,
    status: r.status as ApprovalStatusName,
    decidedBy: r.decidedBy,
    decidedAt: r.decidedAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

export function createPrismaMissionStore(): MissionStore {
  return {
    async createMission(input: CreateMissionInput) {
      const r = await withWorkspaceScope(input.workspaceId, (tx) =>
        tx.mission.create({
          data: {
            id: createId(),
            workspaceId: input.workspaceId,
            template: input.template,
            goal: jsonInput(input.goal),
            status: input.status,
            planSnapshot: jsonInput(input.planSnapshot),
            checkpoints: jsonInput(input.checkpoints),
            budgetCaps: jsonInput(input.budgetCaps),
            termination: jsonInput(input.termination),
            createdBy: input.createdBy,
          },
        }),
      );
      return toMission(r as MissionRow);
    },

    async getMission(missionId, workspaceId) {
      const r = await withWorkspaceScope(workspaceId, (tx) =>
        tx.mission.findFirst({ where: { id: missionId, workspaceId } }),
      );
      return r ? toMission(r as MissionRow) : null;
    },

    async updateMission(missionId, workspaceId, patch: UpdateMissionPatch) {
      const data: Record<string, Prisma.InputJsonValue | string> = {};
      if (patch.status !== undefined) data.status = patch.status;
      if (patch.checkpoints !== undefined) data.checkpoints = jsonInput(patch.checkpoints);
      if (patch.planSnapshot !== undefined) data.planSnapshot = jsonInput(patch.planSnapshot);
      if (patch.termination !== undefined) data.termination = jsonInput(patch.termination);
      const r = await withWorkspaceScope(workspaceId, async (tx) => {
        const existing = await tx.mission.findFirst({ where: { id: missionId, workspaceId } });
        if (!existing) throw new Error("Mission not found in workspace.");
        return tx.mission.update({ where: { id: missionId, workspaceId }, data });
      });
      return toMission(r as MissionRow);
    },

    async claimMissionActivation(missionId, workspaceId) {
      return withWorkspaceScope(workspaceId, async (tx) => {
        // Conditional update: exactly one concurrent claimant wins the row.
        const claimed = await tx.mission.updateMany({
          where: { id: missionId, workspaceId, status: "planned" },
          data: { status: "active" },
        });
        if (claimed.count === 0) return null;
        const row = await tx.mission.findFirst({ where: { id: missionId, workspaceId } });
        return row ? toMission(row as MissionRow) : null;
      });
    },

    async listMissions(workspaceId) {
      const rows = await withWorkspaceScope(workspaceId, (tx) =>
        tx.mission.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } }),
      );
      return rows.map((r) => toMission(r as MissionRow));
    },

    async appendEvent(missionId, workspaceId, input: AppendEventInput) {
      // M1's hash-chained writer (tenant GUC pinned per transaction).
      const { id } = await appendMissionEvent({
        missionId,
        workspaceId,
        actor: input.actor,
        step: input.step ?? undefined,
        tool: input.tool ?? undefined,
        args: input.args,
        observation: input.observation,
        costCents: input.costCents,
      });
      const r = await withWorkspaceScope(workspaceId, (tx) =>
        tx.missionEvent.findFirst({ where: { id, missionId, workspaceId } }),
      );
      if (!r) throw new Error("Mission event write failed.");
      return toEvent(r as MissionEventRow);
    },

    async listEvents(missionId, workspaceId, limit = 500) {
      const rows = await withWorkspaceScope(workspaceId, (tx) =>
        tx.missionEvent.findMany({
          where: { missionId, workspaceId },
          orderBy: { ts: "asc" },
          take: limit,
        }),
      );
      return rows.map((r) => toEvent(r as MissionEventRow));
    },

    async createApproval(input: CreateApprovalInput) {
      const r = await withWorkspaceScope(input.workspaceId, (tx) =>
        tx.missionApproval.create({
          data: {
            id: createId(),
            workspaceId: input.workspaceId,
            missionId: input.missionId ?? null,
            action: input.action,
            tier: input.tier,
            bindingJson: jsonInput(input.bindingJson),
            bindingHash: bindingHashOf(input.bindingJson),
            status: "pending",
            createdBy: input.createdBy,
            expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
          },
        }),
      );
      // Phase 3 (J): best-effort "needs you" notification (never throws).
      await notifyApprovalNeeded({
        workspaceId: input.workspaceId,
        source: "mission",
        sourceId: r.id,
        title: input.action.replace(/[_.]+/g, " "),
        href: input.missionId ? `/dashboard/missions/${encodeURIComponent(input.missionId)}` : undefined,
        requestedBy: input.createdBy,
      });
      return toApproval(r as MissionApprovalRow);
    },

    async getApproval(approvalId, workspaceId) {
      const r = await withWorkspaceScope(workspaceId, (tx) =>
        tx.missionApproval.findFirst({ where: { id: approvalId, workspaceId } }),
      );
      return r ? toApproval(r as MissionApprovalRow) : null;
    },

    async listApprovals(missionId, workspaceId) {
      const rows = await withWorkspaceScope(workspaceId, (tx) =>
        tx.missionApproval.findMany({
          where: { missionId, workspaceId },
          orderBy: { createdAt: "desc" },
        }),
      );
      return rows.map((r) => toApproval(r as MissionApprovalRow));
    },

    async decideApproval(approvalId, workspaceId, decision, decidedBy, decidedAt) {
      const r = await withWorkspaceScope(workspaceId, async (tx) => {
        const existing = await tx.missionApproval.findFirst({ where: { id: approvalId, workspaceId } });
        if (!existing) throw new Error("Approval not found in workspace.");
        return tx.missionApproval.update({
          where: { id: approvalId, workspaceId },
          data: { status: decision, decidedBy, decidedAt },
        });
      });
      return toApproval(r as MissionApprovalRow);
    },

    async markApprovalExpired(approvalId, workspaceId) {
      const r = await withWorkspaceScope(workspaceId, async (tx) => {
        const existing = await tx.missionApproval.findFirst({ where: { id: approvalId, workspaceId } });
        if (!existing) throw new Error("Approval not found in workspace.");
        return tx.missionApproval.update({ where: { id: approvalId, workspaceId }, data: { status: "expired" } });
      });
      return toApproval(r as MissionApprovalRow);
    },
  };
}

/** Graph recency probe for the resume staleness verifier (read-only). */
export async function getGraphNewestAsOf(workspaceId: string): Promise<Date | null> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.$queryRaw<{ newest: Date | null }[]>`
      SELECT MAX(as_of) AS newest FROM graph_nodes WHERE workspace_id = ${workspaceId}`,
  );
  return rows[0]?.newest ?? null;
}

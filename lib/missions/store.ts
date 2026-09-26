// Marketr — Phase 9 M4: mission store interface + memory twin (SPEC-PHASE9.md §P9C).
//
// Mirrors the M1 executor pattern: the engine depends on this interface;
// batteries/tests use the memory twin, API routes use the Prisma twin
// (lib/missions/prisma-store.ts). PURE module — no prisma, no @/ imports.

import { bindingHashOf, canonicalize, eventHashFor, sha256Hex } from "../authority/approvals";
import type {
  ApprovalStatusName,
  CheckpointRecord,
  MissionStatusName,
  TerminationConfig,
} from "./types";

export interface StoredMission {
  id: string;
  workspaceId: string;
  template: string;
  goal: Record<string, unknown>;
  status: MissionStatusName;
  planSnapshot: Record<string, unknown>;
  checkpoints: CheckpointRecord[];
  budgetCaps: Record<string, unknown>;
  termination: TerminationConfig;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredMissionEvent {
  id: string;
  missionId: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  step: string | null;
  tool: string | null;
  args: Record<string, unknown>;
  observation: Record<string, unknown>;
  costCents: number;
  eventHash: string;
  prevHash: string;
}

export interface StoredMissionApproval {
  id: string;
  workspaceId: string;
  missionId: string | null;
  action: string;
  tier: number;
  bindingJson: Record<string, unknown>;
  bindingHash: string;
  status: ApprovalStatusName;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface CreateMissionInput {
  workspaceId: string;
  template: string;
  goal: Record<string, unknown>;
  status: MissionStatusName;
  planSnapshot: Record<string, unknown>;
  checkpoints: CheckpointRecord[];
  budgetCaps: Record<string, unknown>;
  termination: TerminationConfig;
  createdBy: string;
}

export interface UpdateMissionPatch {
  status?: MissionStatusName;
  checkpoints?: CheckpointRecord[];
  planSnapshot?: Record<string, unknown>;
  termination?: TerminationConfig;
}

export interface AppendEventInput {
  actor: string;
  step?: string | null;
  tool?: string | null;
  args?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  costCents?: number;
}

export interface CreateApprovalInput {
  workspaceId: string;
  missionId?: string | null;
  action: string;
  tier: number;
  bindingJson: Record<string, unknown>;
  createdBy: string;
  expiresAt?: Date | null;
}

export interface MissionStore {
  createMission(input: CreateMissionInput): Promise<StoredMission>;
  getMission(missionId: string, workspaceId: string): Promise<StoredMission | null>;
  updateMission(missionId: string, workspaceId: string, patch: UpdateMissionPatch): Promise<StoredMission>;
  listMissions(workspaceId: string): Promise<StoredMission[]>;
  /** Hash-chained append (GENESIS -> ...), same chain contract as M1's audit.appendMissionEvent. */
  appendEvent(missionId: string, workspaceId: string, input: AppendEventInput): Promise<StoredMissionEvent>;
  listEvents(missionId: string, workspaceId: string, limit?: number): Promise<StoredMissionEvent[]>;
  createApproval(input: CreateApprovalInput): Promise<StoredMissionApproval>;
  getApproval(approvalId: string, workspaceId: string): Promise<StoredMissionApproval | null>;
  listApprovals(missionId: string, workspaceId: string): Promise<StoredMissionApproval[]>;
  decideApproval(
    approvalId: string,
    workspaceId: string,
    decision: "approved" | "denied",
    decidedBy: string,
    decidedAt: Date,
  ): Promise<StoredMissionApproval>;
  markApprovalExpired(approvalId: string, workspaceId: string): Promise<StoredMissionApproval>;
}

// ---------------------------------------------------------------------------
// Memory twin (batteries / tests). Same interface as the Prisma twin.
// ---------------------------------------------------------------------------

let idCounter = 0;
function cuid(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createMemoryMissionStore(): MissionStore {
  const missions = new Map<string, StoredMission>();
  const events = new Map<string, StoredMissionEvent[]>(); // missionId -> events (chronological)
  const approvals = new Map<string, StoredMissionApproval>();

  function scopedMission(missionId: string, workspaceId: string): StoredMission {
    const m = missions.get(missionId);
    if (!m || m.workspaceId !== workspaceId) throw new Error("Mission not found in workspace.");
    return m;
  }

  function scopedApproval(approvalId: string, workspaceId: string): StoredMissionApproval {
    const a = approvals.get(approvalId);
    if (!a || a.workspaceId !== workspaceId) throw new Error("Approval not found in workspace.");
    return a;
  }

  return {
    async createMission(input) {
      const now = new Date();
      const m: StoredMission = {
        id: cuid("msn"),
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      missions.set(m.id, m);
      events.set(m.id, []);
      return m;
    },

    async getMission(missionId, workspaceId) {
      const m = missions.get(missionId);
      return m && m.workspaceId === workspaceId ? m : null;
    },

    async updateMission(missionId, workspaceId, patch) {
      const m = scopedMission(missionId, workspaceId);
      const next: StoredMission = {
        ...m,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.checkpoints !== undefined ? { checkpoints: patch.checkpoints } : {}),
        ...(patch.planSnapshot !== undefined ? { planSnapshot: patch.planSnapshot } : {}),
        ...(patch.termination !== undefined ? { termination: patch.termination } : {}),
        updatedAt: new Date(),
      };
      missions.set(missionId, next);
      return next;
    },

    async listMissions(workspaceId) {
      return [...missions.values()]
        .filter((m) => m.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async appendEvent(missionId, workspaceId, input) {
      scopedMission(missionId, workspaceId); // 404 when out of scope
      const list = events.get(missionId) ?? [];
      const prevHash = list.length > 0 ? list[list.length - 1].eventHash : "GENESIS";
      const ts = new Date();
      const payloadHash = sha256Hex(
        canonicalize({
          step: input.step ?? null,
          tool: input.tool ?? null,
          args: input.args ?? {},
          observation: input.observation ?? {},
          costCents: input.costCents ?? 0,
        }),
      );
      const ev: StoredMissionEvent = {
        id: cuid("mev"),
        missionId,
        workspaceId,
        ts,
        actor: input.actor,
        step: input.step ?? null,
        tool: input.tool ?? null,
        args: input.args ?? {},
        observation: input.observation ?? {},
        costCents: input.costCents ?? 0,
        eventHash: eventHashFor(prevHash, missionId, input.actor, payloadHash, ts),
        prevHash,
      };
      list.push(ev);
      events.set(missionId, list);
      return ev;
    },

    async listEvents(missionId, workspaceId, limit = 500) {
      scopedMission(missionId, workspaceId);
      const list = events.get(missionId) ?? [];
      return list.slice(-limit);
    },

    async createApproval(input) {
      const a: StoredMissionApproval = {
        id: cuid("map"),
        workspaceId: input.workspaceId,
        missionId: input.missionId ?? null,
        action: input.action,
        tier: input.tier,
        bindingJson: input.bindingJson,
        bindingHash: bindingHashOf(input.bindingJson),
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        expiresAt: input.expiresAt ?? null,
        createdBy: input.createdBy,
        createdAt: new Date(),
      };
      approvals.set(a.id, a);
      return a;
    },

    async getApproval(approvalId, workspaceId) {
      const a = approvals.get(approvalId);
      return a && a.workspaceId === workspaceId ? a : null;
    },

    async listApprovals(missionId, workspaceId) {
      return [...approvals.values()]
        .filter((a) => a.workspaceId === workspaceId && a.missionId === missionId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async decideApproval(approvalId, workspaceId, decision, decidedBy, decidedAt) {
      const a = scopedApproval(approvalId, workspaceId);
      a.status = decision;
      a.decidedBy = decidedBy;
      a.decidedAt = decidedAt;
      return a;
    },

    async markApprovalExpired(approvalId, workspaceId) {
      const a = scopedApproval(approvalId, workspaceId);
      a.status = "expired";
      return a;
    },
  };
}

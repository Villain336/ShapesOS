// Marketr — Phase 16 slice 4: default DB loaders/applier for shared state.
//
// Server-only (imports prisma). NOT imported by the pure shared-state module
// or by any test — the adapter takes these as injectable deps so tests can
// stub them. The /api/agents/chat route wires these defaults in.

import { prisma } from "@/lib/prisma";
import {
  mapItemsToApprovals,
  mapMissionToState,
  mapOpsSummaryToState,
  mapPostsToCalendar,
  changedCalendarRows,
  mergeSharedState,
  type AppliedStateChange,
  type AutopilotItemLite,
  type MissionEventLite,
  type MissionLite,
  type SharedAgentState,
  type SocialPostLite,
} from "./shared-state";
import { getOpsSummary } from "@/lib/ops/summary";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

/** SocialPost statuses the UI is allowed to set through shared state. */
const UI_WRITABLE_POST_STATUSES = new Set(["draft", "scheduled", "cancelled"]);

export interface SharedStateContext {
  workspaceId: string;
  projectId: string;
}

/**
 * Load the four shared-state domains from their sources of truth.
 * Bounded (50 calendar rows, 25 approval items, 5 mission events) so the
 * STATE_SNAPSHOT stays small. The operations domain is read-only: ops
 * writes stay behind the Phase 14 gate via the ops routes.
 */
export async function defaultLoadSharedState(
  ctx: SharedStateContext,
): Promise<SharedAgentState> {
  const [posts, mission, items, opsSummary] = await Promise.all([
    prisma.socialPost.findMany({
      where: { projectId: ctx.projectId },
      orderBy: [{ scheduledFor: "asc" }, { updatedAt: "desc" }],
      take: 50,
      select: {
        id: true,
        content: true,
        services: true,
        scheduledFor: true,
        status: true,
        updatedAt: true,
      },
    }),
    prisma.mission.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        status: { in: ["active", "paused", "planned"] },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        template: true,
        goal: true,
        status: true,
        checkpoints: true,
        updatedAt: true,
        events: {
          orderBy: { ts: "desc" },
          take: 5,
          select: { step: true, tool: true, ts: true },
        },
      },
    }),
    prisma.autopilotItem.findMany({
      where: { projectId: ctx.projectId, status: "pending" },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        kind: true,
        title: true,
        status: true,
        ruleId: true,
        updatedAt: true,
      },
    }),
    // Phase 17: operations pulse. Ops tables are FORCE RLS, so the summary
    // must run inside withWorkspaceScope (the shared-state loader itself
    // queries prisma directly for the non-RLS domains above).
    withWorkspaceScope(ctx.workspaceId, (tx) => getOpsSummary(tx, ctx.workspaceId)),
  ]);

  const postLites: SocialPostLite[] = posts.map((p) => ({
    id: p.id,
    content: p.content,
    services: p.services,
    scheduledFor: p.scheduledFor,
    status: p.status,
    updatedAt: p.updatedAt,
  }));
  const missionLite: MissionLite | null = mission
    ? {
        id: mission.id,
        template: mission.template,
        goal: mission.goal,
        status: mission.status,
        checkpoints: mission.checkpoints,
        updatedAt: mission.updatedAt,
      }
    : null;
  const eventLites: MissionEventLite[] = (mission?.events ?? []).map((e) => ({
    step: e.step,
    tool: e.tool,
    ts: e.ts,
  }));
  const itemLites: AutopilotItemLite[] = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: i.title,
    status: i.status,
    ruleId: i.ruleId,
    updatedAt: i.updatedAt,
  }));

  return {
    calendar: mapPostsToCalendar(postLites),
    mission: missionLite ? mapMissionToState(missionLite, eventLites) : null,
    approvals: mapItemsToApprovals(itemLites),
    operations: mapOpsSummaryToState(opsSummary),
  };
}

/** Re-exported from the pure module (single source for the type). */
export type { AppliedStateChange };

/**
 * Apply UI-originated state changes (UI→agent direction).
 *
 * Only the content calendar is writable through shared state: mission rows
 * come from the append-only MissionEvent log (orchestrator-owned) and
 * approvals stay behind the Phase 14 gate (approve/deny/edit go through the
 * gate routes with audit — slice 3). Changes the UI may not make
 * (unknown ids, disallowed statuses, bad dates) are reported as skipped,
 * never written.
 */
export async function defaultApplySharedStateUpdates(
  ctx: SharedStateContext,
  prev: SharedAgentState,
  next: SharedAgentState,
): Promise<{ applied: AppliedStateChange[] }> {
  const changes = changedCalendarRows(prev, next);
  const applied: AppliedStateChange[] = [];

  for (const change of changes) {
    const data: { scheduledFor?: Date | null; status?: "draft" | "scheduled" | "cancelled" } = {};
    if (change.scheduledFor !== undefined) {
      if (change.scheduledFor === null) {
        data.scheduledFor = null;
      } else {
        const d = new Date(change.scheduledFor);
        if (Number.isNaN(d.getTime())) {
          applied.push({ domain: "calendar", id: change.id, skipped: "invalid scheduledFor date" });
          continue;
        }
        data.scheduledFor = d;
      }
    }
    if (change.status !== undefined) {
      if (!UI_WRITABLE_POST_STATUSES.has(change.status)) {
        applied.push({
          domain: "calendar",
          id: change.id,
          skipped: `status "${change.status}" is not UI-writable`,
        });
        continue;
      }
      data.status = change.status as "draft" | "scheduled" | "cancelled";
    }
    if (Object.keys(data).length === 0) continue;

    // Scope the write to the workspace's project — never a foreign row.
    const row = await prisma.socialPost.findFirst({
      where: {
        id: change.id,
        project: { id: ctx.projectId, workspaceId: ctx.workspaceId },
      },
      select: { id: true },
    });
    if (!row) {
      applied.push({ domain: "calendar", id: change.id, skipped: "row not found in workspace" });
      continue;
    }
    await prisma.socialPost.update({ where: { id: row.id }, data });
    applied.push({ domain: "calendar", id: change.id, ...dataToChange(data) });
  }

  return { applied };
}

function dataToChange(data: {
  scheduledFor?: Date | null;
  status?: string;
}): { scheduledFor?: string | null; status?: string } {
  return {
    ...(data.scheduledFor !== undefined
      ? { scheduledFor: data.scheduledFor ? data.scheduledFor.toISOString() : null }
      : {}),
    ...(data.status !== undefined ? { status: data.status } : {}),
  };
}

/** Re-export for adapter tests that want the pure merge without the DB. */
export { mergeSharedState };

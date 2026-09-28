// Marketr — Phase 14: mission action requests (slice 4).
//
// The durable mission engine (lib/missions/engine.ts) is PURE — no prisma,
// no @/ imports — so action wiring lives here as a thin helper with an
// INJECTED event appender. A mission step that needs a connected-app tool
// calls requestMissionAction(); the call routes through the Phase 14 gate
// (agentInvokeAction): reads/draft-creators execute logged, everything
// else lands in the approve/deny queue. The mission event log records
// which path the action took — the mission pauses on pending-approval
// (human decides in /dashboard/actions, the mission resumes after).

import {
  agentInvokeAction,
  type AgentInvokeInput,
} from "@/lib/integrations/actions/agent";

export interface MissionEventAppend {
  missionId: string;
  workspaceId: string;
  actor: string;
  step?: string;
  tool?: string;
  args?: Record<string, unknown>;
  observation?: Record<string, unknown>;
}

export interface RequestMissionActionInput {
  missionId: string;
  workspaceId: string;
  appKey: string;
  toolName: string;
  args?: Record<string, unknown>;
  invokedBy?: string;
  /** Injected: engine's event appender (keeps this module DB-agnostic). */
  appendEvent?: (e: MissionEventAppend) => Promise<unknown>;
  http?: AgentInvokeInput["http"];
}

export type MissionActionDisposition = "executed" | "awaiting-approval";

export interface MissionActionResult {
  disposition: MissionActionDisposition;
  approvalId?: string;
  summary: string;
}

/**
 * Request a connected-app action from inside a mission. Returns the
 * disposition; on awaiting-approval the mission should pause until the
 * human decides (the approval carries the mission context in proposedBy).
 */
export async function requestMissionAction(
  input: RequestMissionActionInput,
): Promise<MissionActionResult> {
  const invokedBy = input.invokedBy ?? `mission:${input.missionId}`;
  const res = await agentInvokeAction({
    workspaceId: input.workspaceId,
    appKey: input.appKey,
    toolName: input.toolName,
    args: input.args ?? {},
    invokedBy,
    http: input.http,
  });
  const disposition: MissionActionDisposition =
    res.outcome === "executed" ? "executed" : "awaiting-approval";
  const summary =
    res.outcome === "executed"
      ? `Mission action executed: ${input.appKey}.${input.toolName} (${res.classified.tier})`
      : `Mission action awaiting approval: ${input.appKey}.${input.toolName} — ${res.plainSummary}`;
  if (input.appendEvent) {
    await input.appendEvent({
      missionId: input.missionId,
      workspaceId: input.workspaceId,
      actor: invokedBy,
      tool: "actions.invoke",
      args: { appKey: input.appKey, toolName: input.toolName },
      observation: {
        disposition,
        tier: res.classified.tier,
        ...(res.outcome === "pending-approval" ? { approvalId: res.approvalId } : {}),
      },
    });
  }
  return {
    disposition,
    approvalId: res.outcome === "pending-approval" ? res.approvalId : undefined,
    summary,
  };
}

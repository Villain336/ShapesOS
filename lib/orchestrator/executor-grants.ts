// ShapesOS — Phase 8: each mission executor's frozen allow-list as tool groups (PURE).
//
// The six Phase 9 executors declare frozen allow-lists of abstract tool names
// (RESEARCHER_TOOLS …). When a mission step runs as a sub-agent loop
// (lib/agents/mission-runtime.ts), that allow-list becomes the sub-agent's
// MAXIMUM: every abstract tool maps to the chat tool group that does the
// same job, and the grant is computed by the one grant function
// (computeGrant: ∩ the agent's own maximum). An unmapped tool name grants
// nothing (fail closed).

import { ALWAYS_GRANTED, computeGrant, type Grant, type ToolGroup } from "@/lib/agents/grants";
import { ACTOR_TOOLS } from "./executors/actor";
import { ANALYST_TOOLS } from "./executors/analyst";
import { DRAFTER_TOOLS } from "./executors/drafter";
import { PLANNER_TOOLS } from "./executors/planner";
import { RESEARCHER_TOOLS } from "./executors/researcher";
import { SCHEDULER_TOOLS } from "./executors/scheduler";
import type { ExecutorName } from "./orchestrator";

/** Abstract executor tool → the chat tool group with the same reach. */
export const EXECUTOR_TOOL_GROUPS: Readonly<Record<string, ToolGroup>> = Object.freeze({
  // reads of the workspace's own data (graph, substrate, audit, memory, timeline)
  "substrate.context": "workspace",
  "graph.search": "workspace",
  "audit.read": "workspace",
  "memory.read": "workspace",
  "memory.write": "workspace",
  "plan.validate": "workspace",
  "checkpoint.define": "workspace",
  "mission.timeline.read": "workspace",
  "mission_approval.create": "workspace",
  // drafting
  "draft.compose": "content",
  // calendar-shaped scheduling
  "checkpoint.schedule": "calendar",
  "reminder.propose": "calendar",
  // connected-app actions through the Phase 14 gate
  "actions.invoke": "connectors",
});

export const EXECUTOR_ALLOW_LISTS: Readonly<Record<ExecutorName, readonly string[]>> = Object.freeze({
  researcher: RESEARCHER_TOOLS,
  planner: PLANNER_TOOLS,
  drafter: DRAFTER_TOOLS,
  analyst: ANALYST_TOOLS,
  scheduler: SCHEDULER_TOOLS,
  actor: ACTOR_TOOLS,
});

/** The tool groups an executor's allow-list maps to (unmapped names grant nothing). */
export function executorGroups(executor: ExecutorName): ToolGroup[] {
  const groups = new Set<ToolGroup>();
  for (const t of EXECUTOR_ALLOW_LISTS[executor] ?? []) {
    const g = EXECUTOR_TOOL_GROUPS[t];
    if (g) groups.add(g);
  }
  return [...groups];
}

/** The grant a mission step runs under: its executor's allow-list ∩ the agent's maximum. */
export function executorGrant(executor: ExecutorName): Grant {
  const groups = executorGroups(executor);
  // parentGrant = the allow-list itself (plus the always-granted workspace
  // reads every task gets), so nothing else survives — not even the lead's
  // hand-off ability.
  const ceiling = [...new Set<ToolGroup>([...ALWAYS_GRANTED, ...groups])];
  return computeGrant({ agentKey: executor, requested: groups, parentGrant: ceiling });
}

// ShapesOS — Phase 8: a scheduled skill's subtask on the real agent loop.
//
// lib/scheduler/runner.ts keeps its envelope, concurrency cap, metering and
// audit; with a live model each subtask is a real sub-agent run
// (lib/agents/loop.ts) instead of the deterministic mock result:
//   * an AgentRun (kind playbook) per subtask, so it shows on the Runs page,
//     can be stopped and is metered per run;
//   * grant = the tool groups of the skill's DECLARED tools (+ workspace
//     reads), and a tool filter that hides / refuses every tool the skill did
//     not declare — the T4 envelope, enforced per tool call by the loop;
//   * no person is waiting: a write the rules don't auto-approve ends the
//     subtask "awaiting approval" (it never runs on its own);
//   * Phase 16: the subtask runs are children of ONE AgentRun for the skill
//     run (parentRunId), so a scheduled skill shows as one tree and Stop on
//     it reaches every subtask; each subtask has its own abort controller
//     (stopping it interrupts its in-flight model call).
// In mock mode (no live model) the runner keeps its mock subagents.

import type { Skill } from "@prisma/client";
import { getLlmProviderFor, workloadForAgent } from "@/lib/llm/router";
import { getTool, toolGroup } from "@/lib/chat/tools";
import { computeGrant, connectorGroup, type ToolGroup } from "@/lib/agents/grants";
import { createAgentRun, finishAgentRun, markAgentRunRunning } from "@/lib/agents/runs/service";
import { registerRunAbort, releaseRunAbort } from "@/lib/agents/runs/abort";
import { runAgentLoop, SYSTEM_RUN_ROLE } from "@/lib/agents/loop";
import { GLOBAL_HARD_RULES } from "@/lib/expert/constitution";
import { prisma } from "@/lib/prisma";
import type { Subtask } from "./runner";

/** The agent a scheduled skill runs as (the lead's reach, narrowed by the skill). */
const SKILL_AGENT = "lead" as const;

/** Phase 15.1: with a workspace, its own model key counts as live. */
export async function schedulerLoopIsLive(workspaceId?: string): Promise<boolean> {
  if (!workspaceId) return getLlmProviderFor(workloadForAgent(SKILL_AGENT)).isLive;
  const { resolveWorkloadForWorkspace } = await import("@/lib/llm/workspace");
  return (await resolveWorkloadForWorkspace(workloadForAgent(SKILL_AGENT), workspaceId)).provider.isLive;
}

/** Tool groups a skill's declared tools fall in ("connector.<key>.<tool>" or "<key>.<tool>"). */
export function skillGrantGroups(declaredTools: readonly string[], blockedGroups?: readonly string[] | null): ToolGroup[] {
  const groups = new Set<ToolGroup>(["workspace"]);
  for (const d of declaredTools) {
    if (getTool(d)) groups.add(toolGroup(d));
    else {
      const bare = d.startsWith("connector.") ? d.slice("connector.".length) : d;
      const dot = bare.lastIndexOf(".");
      if (dot > 0) groups.add(connectorGroup(bare.slice(0, dot)));
    }
  }
  // parentGrant = the declared groups: the lead's hand-off ability is not added.
  // Phase 18.3 (WS=trust): minus the apps blocked for agents in the workspace.
  return computeGrant({ agentKey: SKILL_AGENT, requested: [...groups], parentGrant: [...groups], blockedGroups }).groups;
}

/** Only the skill's declared tools (exact, or as connector.<declared>). */
export function declaredToolFilter(declaredTools: readonly string[]): (canonical: string) => boolean {
  const allowed = new Set<string>();
  for (const d of declaredTools) {
    allowed.add(d);
    if (!d.startsWith("connector.") && !getTool(d)) allowed.add(`connector.${d}`);
  }
  return (canonical) => allowed.has(canonical);
}

export interface LiveSubtaskInput {
  workspaceId: string;
  projectId: string | null;
  skill: Pick<Skill, "name" | "slug" | "skillMd" | "declaredTools">;
  subtask: Subtask;
  skillRunId: string;
  subagentRunId: string;
  signal?: AbortSignal;
  /** Phase 16: the skill run's own AgentRun (the subtask runs hang under it). */
  parentRunId?: string;
}

export interface LiveSubtaskResult {
  status: "succeeded" | "failed";
  result: string;
  runId: string;
  costMicroUsd: number;
}

export type LiveSubtaskRunner = (input: LiveSubtaskInput) => Promise<LiveSubtaskResult>;

export const runSkillSubtaskLive: LiveSubtaskRunner = async (input) => {
  const { getAgentBlockedGroups } = await import("@/lib/agents/app-permissions");
  const groups = skillGrantGroups(input.skill.declaredTools, await getAgentBlockedGroups(input.workspaceId));
  const projectId =
    input.projectId ??
    (await prisma.project.findFirst({ where: { workspaceId: input.workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true } }))?.id ??
    "";
  const run = await createAgentRun({
    workspaceId: input.workspaceId,
    kind: "playbook",
    startedBy: "scheduler",
    agentKey: SKILL_AGENT,
    allowedTools: groups,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    agentState: { skillRunId: input.skillRunId, subagentRunId: input.subagentRunId, skill: input.skill.slug, task: input.subtask.label },
  });
  await markAgentRunRunning(input.workspaceId, run.id);
  // Phase 16: this subtask's own controller (Stop on it — or on the skill
  // run above it — interrupts its in-flight model call), tied to the caller's.
  const own = registerRunAbort(run.id);
  const signal = input.signal ? AbortSignal.any([own, input.signal]) : own;
  const system = [
    GLOBAL_HARD_RULES,
    "",
    `You are a ShapesOS sub-agent running the skill "${input.skill.name}" on a schedule. No person is watching this run.`,
    `You may only use the skill's declared tools: ${input.skill.declaredTools.join(", ") || "none (answer from the context)"}.`,
    "Anything that sends, publishes or spends waits for a person's approval; don't retry it.",
    "Finish with a short report in Markdown: findings, numbers, and recommended next steps.",
    "",
    "## Skill",
    input.skill.skillMd.slice(0, 20_000),
  ].join("\n");
  try {
    const loop = await runAgentLoop({
      ctx: {
        projectId,
        workspaceId: input.workspaceId,
        userId: "scheduler",
        role: SYSTEM_RUN_ROLE,
        confirmed: false,
        loadedSkills: new Set([input.skill.slug]),
        agentKey: SKILL_AGENT,
        grant: groups,
        runId: run.id,
        signal,
      },
      system,
      messages: [{ role: "user", content: `${input.subtask.label}\n\n${input.subtask.detail}` }],
      toolFilter: declaredToolFilter(input.skill.declaredTools),
      // Phase 17 (A4): a scheduled skill has no person waiting — it runs the
      // lead's reach on the subagent workload (the cheaper model, no
      // priority capacity, 5-minute cache entries).
      workload: "subagent",
    });
    const ok = loop.status !== "error" && loop.status !== "cancelled";
    await finishAgentRun(input.workspaceId, run.id, loop.status === "cancelled" ? "cancelled" : ok ? "succeeded" : "failed");
    const waiting = loop.status === "awaiting_confirmation" ? `\n\n_Waiting for approval: ${loop.proposal?.tool ?? "an action"} (not run)._` : "";
    return {
      status: ok ? "succeeded" : "failed",
      result: `# ${input.subtask.label}\n\n${loop.finalText}${waiting}`,
      runId: run.id,
      costMicroUsd: loop.state.costMicroUsd,
    };
  } catch (err) {
    await finishAgentRun(input.workspaceId, run.id, "failed").catch(() => undefined);
    throw err;
  } finally {
    releaseRunAbort(run.id);
  }
};

/**
 * Phase 16: the AgentRun a live skill run's subtasks hang under (kind
 * playbook, the lead's agent key) — one tree on the Runs page and in the
 * sidebar, one Stop for the whole fan-out.
 */
export async function createSkillParentRun(input: { workspaceId: string; skillRunId: string; skillName: string; projectId: string | null }): Promise<string> {
  const run = await createAgentRun({
    workspaceId: input.workspaceId,
    kind: "playbook",
    startedBy: "scheduler",
    agentKey: SKILL_AGENT,
    agentState: { skillRunId: input.skillRunId, task: `Scheduled skill: ${input.skillName}`, projectId: input.projectId },
  });
  await markAgentRunRunning(input.workspaceId, run.id);
  return run.id;
}

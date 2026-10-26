// ShapesOS — Phase 8: missions run on the agent runtime.
//
// runMission (lib/orchestrator/orchestrator.ts) finally has a production
// caller. A mission launch (POST /api/missions) enqueues an agent job; the
// worker runs runMission with its caps (steps, timeout, cost budget, hop
// circuit breaker, loop detection), its kill switches (workspace freeze,
// mission pause — checked every hop) and its hash-chained mission audit, all
// unchanged. What changes is the dispatch: with a live model each executor
// step runs as a SUB-AGENT LOOP (lib/agents/loop.ts) as that executor's
// agent, its frozen allow-list mapped to tool groups
// (lib/orchestrator/executor-grants.ts), as a child AgentRun of the
// mission's run. The kill switches are also checked before every model and
// tool call inside the step. In mock mode (no live model) the deterministic
// executors run as before.
//
// The plan's steps run in order up to the first human approval step; the
// mission then waits for that approval (a `mission.awaiting_human` event).
// Re-running after a crash skips steps already done (progress is saved on
// the mission run) and resumes a step's half-finished sub-agent run.

import { prisma } from "@/lib/prisma";
import { workloadForAgent } from "@/lib/llm/router";
import {
  appendAgentRunEvent,
  createAgentRun,
  finishAgentRun,
  getAgentRun,
  markAgentRunRunning,
} from "@/lib/agents/runs/service";
import { prismaTranscriptStore } from "@/lib/agents/runs/transcript";
import { registerRunAbort, releaseRunAbort, abortRunWith, LeaseLostError, isLeaseLost } from "@/lib/agents/runs/abort";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { runAgentLoop, SYSTEM_RUN_ROLE, type LoopContext } from "./loop";
import { subAgentSystemPrompt } from "./roles";
import { agentDisplayName } from "./grants";
import { enqueueAgentJob } from "./queue/store";
import { executorGrant } from "@/lib/orchestrator/executor-grants";
import {
  ROUTING_TABLE,
  runMission,
  type DispatchResult,
  type ExecutorName,
  type MissionTask,
  type RunMissionResult,
} from "@/lib/orchestrator/orchestrator";
import { appendMissionEvent } from "@/lib/orchestrator/audit";
import { isMissionPaused, isWorkspaceFrozen, KillSwitchError } from "@/lib/orchestrator/killswitch";

export interface MissionJobPayload {
  missionId: string;
  workspaceId: string;
  userId: string;
}

const EXECUTOR_KIND: Readonly<Record<ExecutorName, string>> = {
  researcher: "research",
  planner: "plan",
  drafter: "draft",
  analyst: "analyze",
  scheduler: "schedule",
  actor: "act",
};

interface PlanStepLike {
  key?: unknown;
  title?: unknown;
  description?: unknown;
  executor?: unknown;
  order?: unknown;
}

/**
 * The tasks a launch runs: the plan's steps in order, up to (not including)
 * the first human approval step. Returns the human step that stops it.
 */
export function missionInitialTasks(
  planSnapshot: unknown,
  ids: { workspaceId: string; missionId: string },
): { tasks: MissionTask[]; waitingOn: { key: string; title: string } | null } {
  const steps = (((planSnapshot as { steps?: unknown })?.steps ?? []) as PlanStepLike[])
    .slice()
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  const tasks: MissionTask[] = [];
  for (const s of steps) {
    const executor = String(s.executor ?? "");
    const key = String(s.key ?? "");
    const title = String(s.title ?? key);
    if (executor === "human") return { tasks, waitingOn: { key, title } };
    const kind = EXECUTOR_KIND[executor as ExecutorName];
    if (!kind || !ROUTING_TABLE[kind]) continue;
    tasks.push({
      kind,
      label: `${key}: ${title}`,
      workspaceId: ids.workspaceId,
      missionId: ids.missionId,
      payload: { stepId: key, title, description: String(s.description ?? ""), query: title, goal: title, brief: String(s.description ?? title) },
    });
  }
  return { tasks, waitingOn: null };
}

/** Launch: the mission's run + the queued job (POST /api/missions/:id/approve-plan calls this). */
export async function enqueueMissionLaunch(input: MissionJobPayload): Promise<{ runId: string; jobId: string }> {
  return withWorkspaceScope(input.workspaceId, async (tx) => {
    // Durable serialization, not UI discipline: the mission row is locked FOR
    // UPDATE for the whole check+create, so true-parallel launches (API
    // retries, a second tab, a worker race) cannot both pass the existing-run
    // check - the second waits on the lock, then adopts the first's run.
    await tx.$queryRaw`SELECT id FROM missions WHERE id = ${input.missionId} AND workspace_id = ${input.workspaceId} FOR UPDATE`;
    // Whole-plan gate, structural: a mission still at "planned" has not had
    // its drafted plan approved by a person, so it must not launch.
    const mission = await tx.mission.findFirst({
      where: { id: input.missionId, workspaceId: input.workspaceId },
      select: { status: true },
    });
    if (!mission) throw new Error(`Mission ${input.missionId} not found in this workspace.`);
    if (mission.status === "planned") {
      throw new Error("This mission's plan is still awaiting a person's approval - approve the plan before starting it.");
    }
    // Idempotent + retry-safe: one launch run per mission. If a previous
    // attempt created the run but failed before or after queueing the job, a
    // retry resumes from exactly where it stopped instead of double-starting.
    const existing = await tx.agentRun.findFirst({
      where: { workspaceId: input.workspaceId, missionId: input.missionId, kind: "mission", parentRunId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing) {
      const job = await tx.agentJob.findFirst({
        where: { workspaceId: input.workspaceId, runId: existing.id, kind: "mission" },
        select: { id: true },
      });
      if (job) return { runId: existing.id, jobId: job.id };
      const queued = await enqueueAgentJob({ workspaceId: input.workspaceId, kind: "mission", runId: existing.id, payload: input });
      return { runId: existing.id, jobId: queued.id };
    }
    const run = await createAgentRun({
      workspaceId: input.workspaceId,
      kind: "mission",
      startedBy: input.userId,
      missionId: input.missionId,
      agentKey: "lead",
      agentState: { missionId: input.missionId },
    });
    const job = await enqueueAgentJob({ workspaceId: input.workspaceId, kind: "mission", runId: run.id, payload: input });
    await appendAgentRunEvent(input.workspaceId, run.id, { type: "note", summary: "Mission queued for the agent worker" }).catch(() => undefined);
    return { runId: run.id, jobId: job.id };
  });
}

interface MissionProgress {
  v: "mission";
  done: Record<string, DispatchResult>;
}

function isProgress(v: unknown): v is MissionProgress {
  return !!v && typeof v === "object" && (v as MissionProgress).v === "mission" && typeof (v as MissionProgress).done === "object";
}

/** The workspace's oldest project: the context mission tools read from. */
async function missionProjectId(workspaceId: string): Promise<string> {
  const p = await prisma.project.findFirst({ where: { workspaceId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return p?.id ?? "";
}

/** A step's sub-agent run already started (a re-run resumes it). */
async function existingStepRun(workspaceId: string, parentRunId: string, stepId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findFirst({
      where: { workspaceId, parentRunId, agentState: { path: ["stepId"], equals: stepId } },
      select: { id: true, status: true },
    }),
  ).catch(() => null);
}

export interface SubAgentDispatchOptions {
  workspaceId: string;
  missionId: string;
  userId: string;
  parentRunId: string;
  projectId: string;
  goalLabel: string;
  signal?: AbortSignal;
  deps?: Parameters<typeof runAgentLoop>[0]["deps"];
}

/** Each executor step as a sub-agent loop inside its allow-list's tool groups. */
export function subAgentDispatch(opts: SubAgentDispatchOptions) {
  return async (executor: ExecutorName, task: MissionTask): Promise<DispatchResult> => {
    const stepId = String((task.payload as { stepId?: unknown } | undefined)?.stepId ?? task.label);
    // Phase 18.3 (WS=trust): apps blocked for agents in this workspace are dropped.
    const { getAgentBlockedGroups } = await import("@/lib/agents/app-permissions");
    const grant = executorGrant(executor, await getAgentBlockedGroups(opts.workspaceId));
    const name = agentDisplayName(executor);

    let runId: string;
    let resume = false;
    const prior = await existingStepRun(opts.workspaceId, opts.parentRunId, stepId);
    if (prior) {
      runId = prior.id;
      resume = true;
    } else {
      const child = await createAgentRun({
        workspaceId: opts.workspaceId,
        kind: "mission",
        startedBy: opts.userId,
        missionId: opts.missionId,
        agentKey: executor,
        parentRunId: opts.parentRunId,
        allowedTools: grant.groups,
        agentState: { stepId, task: task.label.slice(0, 500), projectId: opts.projectId },
      });
      runId = child.id;
      await markAgentRunRunning(opts.workspaceId, runId);
    }
    const ctx: LoopContext = {
      projectId: opts.projectId,
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      role: SYSTEM_RUN_ROLE,
      confirmed: false,
      loadedSkills: new Set(),
      agentKey: executor,
      grant: grant.groups,
      runId,
      signal: opts.signal,
    };
    // Mission kill switches, checked with Stop before every model / tool call.
    const extraStopCheck = async () => {
      if (await isWorkspaceFrozen(opts.workspaceId)) return "Stopped: the workspace is frozen.";
      if (await isMissionPaused(opts.missionId, opts.workspaceId)) return "Stopped: the mission is paused.";
      return null;
    };
    const p = task.payload as { title?: unknown; description?: unknown } | undefined;
    const system = [
      subAgentSystemPrompt(executor),
      "",
      `You are the ${name} sub-agent of ShapesOS, running one step of the mission "${opts.goalLabel}".`,
      "Do this step only, with your tools. Drafts stay drafts: anything that sends, publishes or spends waits for a person's approval.",
      `This step may only use these tool groups: ${grant.groups.join(", ")}.`,
      "Finish with a short report: what you did, what you found, and what the next step needs to know.",
    ].join("\n");
    const userText = [`Step ${stepId}: ${String(p?.title ?? task.label)}`, String(p?.description ?? "")].filter(Boolean).join("\n\n");

    const loop = await runAgentLoop({
      ctx,
      ...(resume ? {} : { system, messages: [{ role: "user" as const, content: userText }] }),
      extraStopCheck,
      deps: opts.deps,
    });
    if (loop.status === "handoff") throw new LeaseLostError();
    const status = loop.status === "cancelled" ? "cancelled" : loop.status === "error" ? "failed" : "succeeded";
    await finishAgentRun(opts.workspaceId, runId, status).catch(() => undefined);
    if (loop.status === "error") throw new Error(loop.finalText);
    const costCents = Math.ceil(loop.state.costMicroUsd / 10_000);
    const waiting = loop.status === "awaiting_confirmation" ? ` (waiting for approval: ${loop.proposal?.tool ?? "an action"})` : "";
    return { summary: `${name}: ${loop.finalText || "done"}${waiting}`.slice(0, 2000), costCents };
  };
}

export interface RunMissionJobOptions {
  signal?: AbortSignal;
  runId?: string | null;
  /** Test seam: force the sub-agent loop (true) or the deterministic executors (false). */
  live?: boolean;
  loopDeps?: Parameters<typeof runAgentLoop>[0]["deps"];
}

/** The worker side of a mission launch (agent job `mission`). */
export async function runMissionJob(
  payload: MissionJobPayload,
  opts: RunMissionJobOptions = {},
): Promise<RunMissionResult & { runId: string | null }> {
  const { workspaceId, missionId } = payload;
  const mission = await withWorkspaceScope(workspaceId, (tx) =>
    tx.mission.findFirst({ where: { id: missionId, workspaceId }, select: { id: true, planSnapshot: true, goal: true, status: true } }),
  );
  if (!mission) throw new Error(`Mission ${missionId} not found in this workspace.`);
  const runId = opts.runId ?? null;
  if (runId) {
    const run = await getAgentRun(workspaceId, runId);
    if (run && (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled")) {
      return { status: "complete", reason: "queue_drained", steps: 0, hops: 0, costCents: 0, runId };
    }
    if (run?.status === "queued") await markAgentRunRunning(workspaceId, runId);
  }

  const { tasks, waitingOn } = missionInitialTasks(mission.planSnapshot, { workspaceId, missionId });
  // Phase 15.1: the workspace's own model key counts as live.
  const live =
    opts.live ??
    (await (await import("@/lib/llm/workspace")).resolveWorkloadForWorkspace(workloadForAgent("researcher"), workspaceId)).provider.isLive;
  const progress: MissionProgress = { v: "mission", done: {} };
  if (runId) {
    const saved = await prismaTranscriptStore.load(workspaceId, runId).catch(() => null);
    if (isProgress(saved)) Object.assign(progress.done, saved.done);
  }
  const goalLabel = String((mission.goal as { label?: unknown } | null)?.label ?? missionId);

  const signal = runId ? registerRunAbort(runId) : opts.signal;
  const onLeaseLost = () => runId && abortRunWith(runId, new LeaseLostError());
  opts.signal?.addEventListener("abort", onLeaseLost, { once: true });
  try {
    const inner = live && runId
      ? subAgentDispatch({
          workspaceId,
          missionId,
          userId: payload.userId,
          parentRunId: runId,
          projectId: await missionProjectId(workspaceId),
          goalLabel,
          signal,
          deps: opts.loopDeps,
        })
      : undefined;
    const dispatch = inner
      ? async (executor: ExecutorName, task: MissionTask): Promise<DispatchResult> => {
          const stepId = String((task.payload as { stepId?: unknown } | undefined)?.stepId ?? task.label);
          // Done before a crash: never run a finished step again.
          if (progress.done[stepId]) return { ...progress.done[stepId], costCents: 0 };
          const res = await inner(executor, task);
          progress.done[stepId] = { summary: res.summary, costCents: res.costCents };
          if (runId) await prismaTranscriptStore.save(workspaceId, runId, progress, Object.keys(progress.done).length).catch(() => undefined);
          return res;
        }
      : undefined;

    const result = await runMission({
      missionId,
      workspaceId,
      initialTasks: tasks,
      deps: dispatch ? { dispatch } : {},
    });
    if (isLeaseLost(signal)) throw new LeaseLostError();
    if (waitingOn && result.status === "complete") {
      await appendMissionEvent({
        missionId,
        workspaceId,
        actor: "chief-strategy-agent",
        step: "mission.awaiting_human",
        observation: { stepKey: waitingOn.key, title: waitingOn.title, note: "The plan waits for a person's approval here." },
      });
    }
    if (runId) {
      await appendAgentRunEvent(workspaceId, runId, {
        type: "note",
        summary: `Mission run ${result.status} (${result.reason}): ${result.steps} steps${waitingOn ? `, waiting on "${waitingOn.title}"` : ""}`,
        payload: { kind: "mission_result", ...result },
      }).catch(() => undefined);
      // complete → succeeded; paused / escalated (stopped for a person) →
      // cancelled; terminated by a cap or loop detection → failed.
      await finishAgentRun(
        workspaceId,
        runId,
        result.status === "complete" ? "succeeded" : result.status === "terminated" ? "failed" : "cancelled",
      );
    }
    return { ...result, runId };
  } catch (err) {
    if (isLeaseLost(signal) || (err as { name?: unknown })?.name === "LeaseLostError") throw err;
    if (err instanceof KillSwitchError) {
      // A frozen workspace is a hard halt, not a failure to retry.
      if (runId) {
        await appendAgentRunEvent(workspaceId, runId, { type: "gate", summary: err.message.slice(0, 500) }).catch(() => undefined);
        await finishAgentRun(workspaceId, runId, "cancelled").catch(() => undefined);
      }
      return { status: "paused", reason: "mission_paused", steps: 0, hops: 0, costCents: 0, runId };
    }
    if (runId) await finishAgentRun(workspaceId, runId, "failed").catch(() => undefined);
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onLeaseLost);
    if (runId) releaseRunAbort(runId);
  }
}

// ShapesOS — Phase 16: automatic parallel delegation (the runtime half).
//
// The lead works the way Claude Code orchestrates sub-agents:
//
//   1. delegate_tasks — a structured plan { goal, tasks[], mergeInstructions }
//      (validated in lib/agents/delegation/plan.ts: no cycles, known agents,
//      width / depth caps, budget shares). delegate_to_subagent stays as the
//      one-task form and is implemented on top of it.
//   2. Each task becomes a child AgentRun (parentRunId) run by a
//      `subagent_run` agent job — NOT inline — so siblings really run at the
//      same time and survive a worker restart (their transcripts are saved
//      after every step). The delegating run records the plan on its own row
//      and ends its step `waiting_on_children`; it holds no worker meanwhile.
//   3. Each child is capped at its share of the parent's remaining budget
//      (cost, model calls, time) with a guard that stops before a call that
//      would cross it; unused budget returns at the join.
//   4. A child that wants an action the user must OK waits as
//      `awaiting_confirmation` (never `succeeded`); once nothing else is
//      running ONE chat message lists every waiting proposal. "yes" runs them
//      (each as the agent that proposed it, inside the grant it was proposed
//      under — Tier 3 and destructive always ask, auto rules apply per child
//      agent) and resumes THAT child from its own transcript; a new message
//      declines them and the children carry on without.
//   5. The last task to finish triggers the join exactly once
//      (lib/agents/delegation/store.ts): the delegating run's transcript gets
//      every deliverable — failed and stopped tasks included — and it checks,
//      may retry each failed task once, merges and answers.
//   6. Stop: each child has its own abort controller (abortRun(childRunId)
//      interrupts only its in-flight model call); stopping the lead cascades
//      to every child (requestAgentRunCancel walks the tree). A lost worker
//      lease leaves the child resumable — never `succeeded` (BUG 1).

import type { WorkspaceRole } from "@prisma/client";
import { registerExtraTool, type ToolContext, type ToolDef, type ToolResult } from "./tools";
import {
  DELEGATE_TASKS_TOOL,
  DELEGATE_TOOL,
  runEvent,
  stopRequested,
  type ChatToolCall,
  type LoopContext,
} from "./tool-exec";
import { AGENT_MAX_GROUPS, agentDisplayName, computeGrant, isAgentKey, type AgentKey, type ToolGroup } from "@/lib/agents/grants";
import { isLoopState, loopLimitsFromEnv, runAgentLoop, toolResultFor, type AgentLoopDeps, type AgentLoopResult, type LoopState } from "@/lib/agents/loop";
import { prismaTranscriptStore } from "@/lib/agents/runs/transcript";
import { abortRunWith, isLeaseLost, LeaseLostError, registerRunAbort, releaseRunAbort } from "@/lib/agents/runs/abort";
import { finishAgentRun, getAgentRun, markAgentRunRunning } from "@/lib/agents/runs/service";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  childBriefMessage,
  DELIVERABLE_INSTRUCTIONS,
  parseDeliverable,
  splitBudget,
  validateDelegationPlan,
  type DelegationPlanState,
  type DelegationTaskState,
} from "@/lib/agents/delegation/plan";
import {
  armDelegation,
  getDelegation,
  loadDelegationSettings,
  planIdFor,
  readDelegatedBy,
  recordPlan,
  settleDelegation,
  type DelegationContinuation,
  type SubagentRunJobPayload,
  type TaskUpdate,
} from "@/lib/agents/delegation/store";
import { applyJoinToState, patchDecidedProposals, placeholderSaved, type DecidedProposal } from "@/lib/agents/delegation/join";
import { connectorChatTools } from "./connector-tools";
import { DELEGATION_GUIDANCE } from "@/lib/agents/roles";

// ── the tools ───────────────────────────────────────────────────────────────

const AGENT_LIST = "researcher, planner, drafter (Writer), analyst, scheduler, actor (Operator)";

const TASK_ITEM_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string", description: "Short unique id, e.g. t1." },
    agent: { type: "string", description: `Sub-agent: ${AGENT_LIST}.` },
    brief: { type: "string", description: "Self-contained instructions with the context the sub-agent needs." },
    tools: { type: "array", items: { type: "string" }, description: 'Optional tool groups to narrow it to (e.g. ["web","files"]).' },
    dependsOn: { type: "array", items: { type: "string" }, description: "Optional ids of tasks that must succeed first; their results are passed on." },
    deliverable: { type: "string", description: "What it must hand back." },
    budgetShare: { type: "number", description: "Optional share (0–1] of the budget left for sub-agents; default an even split." },
    fixes: { type: "string", description: "Only when retrying: the id of the failed task this one retries." },
  },
  required: ["id", "agent", "brief", "deliverable"],
};

/** The plan's tool_result while the sub-agents work (the join replaces it). */
function waitingResult(parentRunId: string, plan: DelegationPlanState): ToolResult {
  const n = plan.tasks.length;
  return {
    summary: `Working with ${n} sub-agent${n === 1 ? "" : "s"}: ${plan.goal.slice(0, 200)}`,
    details: {
      delegationWait: true,
      delegation: { parentRunId, planId: plan.planId, tasks: n, goal: plan.goal.slice(0, 300) },
    },
  };
}

function modeFor(agentKey: AgentKey, grant: readonly ToolGroup[]): "build" | "default" {
  return agentKey === "actor" && grant.includes("code") ? "build" : "default";
}

/**
 * Start a plan from inside the delegating run's tool step. Idempotent per
 * tool_use id (a resumed run gets the plan it already made). Throws with a
 * model-readable reason when the plan is refused — nothing starts then.
 */
async function startPlan(ctx: ToolContext, raw: unknown, via: typeof DELEGATE_TASKS_TOOL | typeof DELEGATE_TOOL): Promise<ToolResult> {
  const lctx = ctx as LoopContext;
  if (!ctx.runId || !lctx.toolUseId) throw new Error("Sub-agents can only be started from a tracked agent run.");
  const settings = await loadDelegationSettings(ctx.workspaceId);
  if (via === DELEGATE_TASKS_TOOL && !settings.autoDelegation) {
    throw new Error("Automatic delegation is off for this workspace (Settings → Automation). Do the work yourself, or hand one task over with delegate_to_subagent.");
  }
  const info = await getDelegation(ctx.workspaceId, ctx.runId);
  const existing = info?.state?.plans.find((p) => p.toolUseId === lctx.toolUseId);
  if (existing) return waitingResult(ctx.runId, existing);

  const depth = lctx.delegationDepth ?? 0;
  const v = validateDelegationPlan(raw, { limits: settings.limits, depth, previous: info?.state?.plans ?? [] });
  if (!v.ok) throw new Error(`The plan was not started:\n- ${v.errors.join("\n- ")}`);

  // The budget the children share: what is left of this run's.
  const env = loopLimitsFromEnv();
  const now = Date.now();
  const split = splitBudget(
    {
      costMicroUsd: lctx.costLeftMicroUsd ?? env.maxCostMicroUsd,
      steps: lctx.stepsLeft ?? env.maxSteps,
      ms: Math.max(0, (lctx.deadlineAt ?? now + env.maxMs) - now),
    },
    v.plan.tasks,
  );
  if (!split.ok) throw new Error(split.error);

  const parentGrant: readonly string[] = ctx.grant ?? AGENT_MAX_GROUPS.lead;
  const planId = planIdFor(ctx.runId, lctx.toolUseId);
  const tasks: DelegationTaskState[] = v.plan.tasks.map((t) => {
    const g = computeGrant({ agentKey: t.agent as AgentKey, requested: t.tools ?? null, parentGrant });
    return {
      id: t.id,
      agent: t.agent as DelegationTaskState["agent"],
      brief: t.brief,
      deliverableSpec: t.deliverable,
      dependsOn: [...t.dependsOn],
      requestedTools: t.tools ?? null,
      grant: g.groups,
      dropped: g.dropped,
      budgetShare: split.split.shares[t.id]!,
      budget: split.split.perTask[t.id]!,
      ...(t.fixes ? { fixes: t.fixes } : {}),
      status: "pending",
    };
  });
  const plan: DelegationPlanState = {
    planId,
    toolUseId: lctx.toolUseId,
    goal: v.plan.goal,
    mergeInstructions: v.plan.mergeInstructions,
    depth: depth + 1,
    round: info?.state?.plans.length ? 1 : 0,
    createdAt: new Date(now).toISOString(),
    armed: false,
    reserve: split.split.reserve,
    tasks,
  };
  const base = {
    projectId: ctx.projectId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    role: ctx.role,
  };
  const agentKey: AgentKey = ctx.agentKey && isAgentKey(ctx.agentKey) ? ctx.agentKey : "lead";
  const continuation: DelegationContinuation = info?.delegatedBy
    ? {
        kind: "subagent_run",
        payload: {
          ...base,
          role: String(ctx.role),
          threadId: lctx.threadId ?? null,
          parentRunId: info.delegatedBy.parentRunId,
          planId: info.delegatedBy.planId,
          taskId: info.delegatedBy.taskId,
        },
      }
    : {
        kind: "chat_turn",
        payload: {
          ...base,
          threadId: lctx.threadId ?? "",
          userContent: "(the sub-agents' results are back)",
          agentKey,
          grant: [...(ctx.grant ?? AGENT_MAX_GROUPS.lead)] as ToolGroup[],
          mode: modeFor(agentKey, (ctx.grant ?? AGENT_MAX_GROUPS.lead) as readonly ToolGroup[]),
        },
      };
  const rec = await recordPlan({ workspaceId: ctx.workspaceId, runId: ctx.runId, plan, continuation });
  if (rec.created) {
    await runEvent(
      ctx,
      `Delegated ${tasks.length} task${tasks.length === 1 ? "" : "s"}: ${plan.goal.slice(0, 200)}`,
      {
        kind: "delegation_plan",
        planId,
        tasks: tasks.map((t) => ({ id: t.id, agent: t.agent, dependsOn: t.dependsOn, budget: t.budget, grant: t.grant, dropped: t.dropped })),
        reserve: plan.reserve,
      },
      "note",
    );
  }
  return waitingResult(ctx.runId, rec.plan);
}

const delegate_tasks: ToolDef = {
  name: DELEGATE_TASKS_TOOL,
  description:
    "Split work across sub-agents that run IN PARALLEL, each with its own brief, narrower tools and a share of this run's budget; you get every deliverable back to check and merge. " +
    `Use for independent parts, parts that need different specialists (${AGENT_LIST}), or work bigger than about a third of this run. Not for a single tool call. ` +
    "dependsOn makes a task wait for others and hands it their results. Each sub-agent's actions still wait for the user's OK unless a rule allows them.",
  // Safe to call: it only starts sub-agents; their own tools go through every gate.
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      goal: { type: "string", description: "What the whole plan achieves (required)." },
      tasks: { type: "array", description: "One entry per sub-agent task (required).", items: TASK_ITEM_SCHEMA },
      mergeInstructions: { type: "string", description: "How you will check and combine the results into one answer (required)." },
    },
    required: ["goal", "tasks", "mergeInstructions"],
  },
  execute: (ctx, args) => startPlan(ctx, args, DELEGATE_TASKS_TOOL),
};

const delegate_to_subagent: ToolDef = {
  name: DELEGATE_TOOL,
  description:
    "Hand one focused piece of work to a sub-agent and get its result back. Use it when a task needs a specialist: agent is one of researcher, planner, drafter (Writer), analyst, scheduler, actor (Operator). The sub-agent works inside this task's tools (optionally fewer) and its write actions still wait for the user's OK.",
  // Safe to call: the sub-agent's own tools go through every gate.
  kind: "safe",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Sub-agent key: researcher | planner | drafter | analyst | scheduler | actor (required)." },
      task: { type: "string", description: "What the sub-agent should do, with the context it needs (required)." },
      tools: { type: "string", description: 'Optional comma-separated tool groups to narrow it further (e.g. "web,files").' },
    },
    required: ["agent", "task"],
  },
  // Phase 16: the one-task form of delegate_tasks (same plan, same runtime).
  async execute(ctx, args) {
    const sub = typeof args.agent === "string" ? args.agent.trim() : "";
    const task = typeof args.task === "string" ? args.task.trim().slice(0, 4000) : "";
    if (!isAgentKey(sub) || sub === "lead") {
      throw new Error(`Unknown sub-agent "${sub}". Use one of: researcher, planner, drafter, analyst, scheduler, actor.`);
    }
    if (!task) throw new Error("Say what the sub-agent should do (task).");
    const tools =
      typeof args.tools === "string" && args.tools.trim() ? args.tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    return startPlan(
      ctx,
      {
        goal: task.slice(0, 2000),
        tasks: [{ id: "task", agent: sub, brief: task, ...(tools ? { tools } : {}), deliverable: "A short report: what you did, what you found and anything left open." }],
        mergeInstructions: `Check the ${agentDisplayName(sub)}'s report against the task, then relay it to the user in your own words.`,
      },
      DELEGATE_TOOL,
    );
  },
};

registerExtraTool(delegate_to_subagent);
registerExtraTool(delegate_tasks);

/** Hide the delegation tools a run may not use (automatic delegation off, or no depth left). */
export function delegationToolFilter(opts: { autoDelegation: boolean; depth: number; maxDepth: number }): ((canonical: string) => boolean) | undefined {
  const noneLeft = opts.depth + 1 > opts.maxDepth;
  if (!noneLeft && opts.autoDelegation) return undefined;
  return (canonical) => {
    if (canonical === DELEGATE_TASKS_TOOL) return !noneLeft && opts.autoDelegation;
    if (canonical === DELEGATE_TOOL) return !noneLeft;
    return true;
  };
}

// ── the child ───────────────────────────────────────────────────────────────

export interface ChildRunOptions {
  /** The worker's lease signal (lost lease → hand-off, never a finish). */
  signal?: AbortSignal;
  /** No retry after this attempt: an infrastructure error fails the task. */
  lastAttempt?: boolean;
  /** Test seam (provider / store). */
  deps?: AgentLoopDeps;
}

async function setRunStatus(workspaceId: string, runId: string, status: "awaiting_confirmation" | "running"): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) => tx.agentRun.update({ where: { id: runId, workspaceId }, data: { status } }));
}

async function meterSpawn(p: SubagentRunJobPayload): Promise<string | null> {
  try {
    const { meter } = await import("@/lib/metering/service");
    const res = await meter({
      workspaceId: p.workspaceId,
      projectId: p.projectId || null,
      actorId: p.userId || null,
      action: "subagent_spawn",
      idempotencyKey: `subagent-spawn:${p.childRunId}`,
      evidenceRef: `agent-run:${p.childRunId}`,
    });
    if (!res.ok && res.reason === "cap_exceeded") return res.message;
    return null;
  } catch {
    // Metering never fails a run (the scheduler's rule): the ledger is best effort here.
    return null;
  }
}

/**
 * Run (or resume) one delegated child — the `subagent_run` job. Settles its
 * task on the parent. Throws LeaseLostError when the worker lost the job
 * (the run stays `running`; whoever claims the job next resumes it).
 */
export async function runDelegatedChild(p: SubagentRunJobPayload, opts: ChildRunOptions = {}): Promise<Record<string, unknown>> {
  const ws = p.workspaceId;
  const run = await getAgentRun(ws, p.childRunId);
  if (!run) throw new Error(`Sub-agent run ${p.childRunId} not found in this workspace.`);
  const by = readDelegatedBy(run.agentState);
  if (!by) throw new Error(`Run ${p.childRunId} is not a delegated sub-agent.`);
  const status = String(run.status);
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    await settleDelegation(ws, by.parentRunId);
    return { childRunId: p.childRunId, skipped: status };
  }
  if (status === "awaiting_confirmation") return { childRunId: p.childRunId, skipped: status };
  const parent = await getDelegation(ws, by.parentRunId);
  const plan = parent?.state?.plans.find((x) => x.planId === by.planId);
  const task = plan?.tasks.find((x) => x.id === by.taskId);
  const settle = (u: Omit<TaskUpdate, "planId" | "taskId">) => settleDelegation(ws, by.parentRunId, { planId: by.planId, taskId: by.taskId, ...u });
  if (!plan || !task) {
    await finishAgentRun(ws, p.childRunId, "failed").catch(() => undefined);
    return { childRunId: p.childRunId, failed: "its plan is gone" };
  }
  if (status === "queued") await markAgentRunRunning(ws, p.childRunId);

  const agent = task.agent as AgentKey;
  const signal = registerRunAbort(p.childRunId);
  const onLeaseLost = () => abortRunWith(p.childRunId, new LeaseLostError());
  if (opts.signal?.aborted) onLeaseLost();
  opts.signal?.addEventListener("abort", onLeaseLost, { once: true });
  const ctx: LoopContext = {
    projectId: p.projectId,
    workspaceId: ws,
    userId: p.userId,
    role: p.role as WorkspaceRole,
    confirmed: false,
    loadedSkills: new Set<string>(),
    agentKey: agent,
    grant: task.grant as ToolGroup[],
    runId: p.childRunId,
    signal,
    threadId: p.threadId ?? undefined,
    delegationDepth: by.depth,
  };
  try {
    if (await stopRequested(ctx)) {
      await settle({ status: "cancelled", error: "Stopped before it started." });
      await finishAgentRun(ws, p.childRunId, "cancelled").catch(() => undefined);
      return { childRunId: p.childRunId, status: "cancelled" };
    }
    const agentMod = await import("./agent");
    if (!(await agentMod.agentIsLive(agent, "default", ws))) {
      await settle({ status: "failed", error: `${agentDisplayName(agent)} needs a live model to work on its own.` });
      await finishAgentRun(ws, p.childRunId, "failed").catch(() => undefined);
      return { childRunId: p.childRunId, status: "failed" };
    }
    const capped = await meterSpawn(p);
    if (capped) {
      await settle({ status: "failed", error: capped });
      await finishAgentRun(ws, p.childRunId, "failed").catch(() => undefined);
      return { childRunId: p.childRunId, status: "failed" };
    }

    const settings = await loadDelegationSettings(ws);
    const limits = { maxSteps: task.budget.steps, maxMs: task.budget.ms, maxCostMicroUsd: task.budget.costMicroUsd };
    const [connectorTools, streamGuard] = await Promise.all([
      connectorChatTools(p.projectId, task.grant as ToolGroup[]).catch(() => []),
      agentMod.styleStreamGuard(ws),
    ]);
    const common = {
      ctx,
      limits,
      budgetGuard: true,
      streamGuard,
      toolFilter: delegationToolFilter({ autoDelegation: settings.autoDelegation, depth: by.depth, maxDepth: settings.limits.maxDepth }),
      deps: { connectorTools, ...(opts.deps ?? {}) },
    };

    const saved = await prismaTranscriptStore.load(ws, p.childRunId).catch(() => null);
    let loop: AgentLoopResult;
    if (isLoopState(saved)) {
      // A resume: after a lease loss, the user's decision, or its own sub-agents' join.
      const own = await getDelegation(ws, p.childRunId);
      if (own?.state) applyJoinToState(saved, own.state.plans, { now: Date.now(), maxMs: limits.maxMs });
      loop = await runAgentLoop({ ...common, state: saved });
    } else {
      const { system, context } = await agentMod.delegatedChildSystemPrompt(p.projectId, ws, agent, task.grant as ToolGroup[]);
      const prerequisites = plan.tasks.filter((x) => task.dependsOn.includes(x.id));
      loop = await runAgentLoop({
        ...common,
        system,
        // Phase 17 (A1): the project context rides in the first user turn, after the cached static prefix.
        messages: agentMod.withContextBlock([{ role: "user", content: childBriefMessage({ goal: plan.goal, task, prerequisites }) }], context),
      });
    }
    return await settleChildLoop(p, by.parentRunId, loop, settle);
  } catch (err) {
    if (isLeaseLost(signal) || (err as { name?: unknown })?.name === "LeaseLostError") throw err;
    if (!opts.lastAttempt) throw err; // the queue retries with backoff
    const msg = err instanceof Error ? err.message : String(err);
    await settle({ status: "failed", error: msg.slice(0, 500) });
    await finishAgentRun(ws, p.childRunId, "failed").catch(() => undefined);
    return { childRunId: p.childRunId, status: "failed", error: msg };
  } finally {
    opts.signal?.removeEventListener("abort", onLeaseLost);
    releaseRunAbort(p.childRunId);
  }
}

async function settleChildLoop(
  p: SubagentRunJobPayload,
  parentRunId: string,
  loop: AgentLoopResult,
  settle: (u: Omit<TaskUpdate, "planId" | "taskId">) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const ws = p.workspaceId;
  const used = {
    costMicroUsd: loop.state.costMicroUsd,
    steps: loop.state.steps,
    activeMs: Math.max(0, Date.now() - loop.state.startedAt),
  };
  switch (loop.status) {
    case "handoff":
      // BUG 1 fix: a lost lease is never a finish — the run stays resumable.
      throw new LeaseLostError();
    case "waiting_on_children":
      // This child delegated one more level: its own children start now.
      await armDelegation(ws, p.childRunId);
      return { childRunId: p.childRunId, status: "waiting_on_children" };
    case "awaiting_confirmation": {
      const proposals: ChatToolCall[] = (loop.proposals ?? (loop.proposal ? [loop.proposal] : [])).map((c) => ({
        ...c,
        runId: p.childRunId,
        agentKey: c.agentKey ?? undefined,
      }));
      await setRunStatus(ws, p.childRunId, "awaiting_confirmation");
      await settle({ status: "awaiting_confirmation", proposals, ...used });
      return { childRunId: p.childRunId, status: "awaiting_confirmation", proposals: proposals.length };
    }
    // The task's outcome lands BEFORE the run is finished: a sibling settling
    // in between must never see the run end without its real outcome.
    case "done": {
      await settle({ status: "succeeded", deliverable: parseDeliverable(loop.finalText), ...used });
      await finishAgentRun(ws, p.childRunId, "succeeded").catch(() => undefined);
      return { childRunId: p.childRunId, status: "succeeded" };
    }
    case "cancelled": {
      await settle({ status: "cancelled", error: "Stopped before it finished.", ...used });
      await finishAgentRun(ws, p.childRunId, "cancelled").catch(() => undefined);
      return { childRunId: p.childRunId, status: "cancelled" };
    }
    default: {
      // capped / refused / error: an honest failure, with whatever it had.
      const why =
        loop.status === "capped"
          ? `It reached its share of the budget (${loop.cap ?? "limit"}) before finishing.`
          : loop.status === "refused"
            ? "The model declined this task."
            : loop.finalText || "The sub-agent stopped on an error.";
      await settle({
        status: "failed",
        error: why.slice(0, 500),
        ...(loop.finalText && loop.status === "capped" ? { deliverable: parseDeliverable(loop.finalText) } : {}),
        ...used,
      });
      await finishAgentRun(ws, p.childRunId, "failed").catch(() => undefined);
      return { childRunId: p.childRunId, status: "failed", parentRunId };
    }
  }
}

/** The reaper dead-lettered a child's job: its task failed (the parent must not wait forever). */
export async function settleDeadChild(workspaceId: string, childRunId: string | null, reason: string): Promise<void> {
  if (!childRunId) return;
  const run = await getAgentRun(workspaceId, childRunId);
  const by = run ? readDelegatedBy(run.agentState) : null;
  if (!by) return;
  await settleDelegation(workspaceId, by.parentRunId, { planId: by.planId, taskId: by.taskId, status: "failed", error: reason });
}

// ── ticks and joins ─────────────────────────────────────────────────────────

/**
 * The `delegation_tick` job: arm a plan whose run saved its waiting state
 * (the safety net when the run's own arming never came), then settle (start
 * tasks a cap held back). A plan whose run is still mid-step waits.
 */
/** Safety-net re-checks of an unarmed plan (every 30 s → about 10 minutes). */
const MAX_ARM_CHECKS = 20;

export async function pumpDelegation(workspaceId: string, parentRunId: string, check = 0): Promise<Record<string, unknown>> {
  const d = await getDelegation(workspaceId, parentRunId);
  if (!d?.state) return { parentRunId, skipped: "no plan" };
  const unarmed = d.state.plans.filter((p) => !p.armed && !p.joinedAt);
  if (unarmed.length) {
    const saved = await prismaTranscriptStore.load(workspaceId, parentRunId).catch(() => null);
    if (isLoopState(saved) && unarmed.every((p) => placeholderSaved(saved, p))) {
      const fx = await armDelegation(workspaceId, parentRunId);
      return { parentRunId, armed: true, jobs: fx.jobs };
    }
    if (d.status === "running" && check < MAX_ARM_CHECKS) {
      // Still finishing its step: look again later.
      const { enqueueAgentJob } = await import("@/lib/agents/queue/store");
      await enqueueAgentJob({
        workspaceId,
        kind: "delegation_tick",
        runId: parentRunId,
        payload: { workspaceId, parentRunId, safetyNet: true, check: check + 1 },
        runAfter: new Date(Date.now() + 30_000),
      });
      return { parentRunId, recheck: check + 1 };
    }
    return { parentRunId, skipped: "not armed" };
  }
  const fx = await settleDelegation(workspaceId, parentRunId);
  return { parentRunId, jobs: fx.jobs, joined: fx.joined };
}

export type DelegationJoinPayload =
  | { kind: "chat_turn"; planId: string; turn: import("./agent").ChatTurnJobPayload }
  | { kind: "subagent_run"; planId: string; run: SubagentRunJobPayload };

/** The `delegation_join` job: the delegating run carries on with every result. */
export async function runDelegationJoin(payload: DelegationJoinPayload, opts: ChildRunOptions = {}): Promise<unknown> {
  if (payload.kind === "subagent_run") return runDelegatedChild(payload.run, opts);
  const { continueTrackedAgentTurn } = await import("./agent");
  const out = await continueTrackedAgentTurn(payload.turn, { signal: opts.signal });
  return { runId: out.runId, waiting: out.waiting === true, awaitingConfirmation: out.awaitingConfirmation === true };
}

// ── the user's decision on sub-agents' proposals ────────────────────────────

export interface ProposalDecision {
  /** The pending call from the chat message (runId = the run that proposed it). */
  call: ChatToolCall;
  /** "approved": exec ran (its result); "declined": not run. */
  exec: ChatToolCall;
  result: import("./tools").ToolResult | null;
}

/** Which runs these proposals came from, and whether each is a delegated child. */
export async function classifyProposalRuns(workspaceId: string, runIds: readonly string[]): Promise<Map<string, { child: boolean; waitingOnChildren: boolean; status: string }>> {
  const out = new Map<string, { child: boolean; waitingOnChildren: boolean; status: string }>();
  for (const id of new Set(runIds)) {
    const d = await getDelegation(workspaceId, id).catch(() => null);
    if (!d) continue;
    out.set(id, { child: !!d.delegatedBy, waitingOnChildren: !!d.state?.plans.some((p) => !p.joinedAt), status: d.status });
  }
  return out;
}

/**
 * Patch a run's saved transcript with the user's decisions (the real result,
 * or "declined") without running it. Returns the patched state (null when the
 * transcript doesn't hold these calls).
 */
export async function patchRunWithDecisions(workspaceId: string, runId: string, decisions: readonly ProposalDecision[]): Promise<LoopState | null> {
  const saved = await prismaTranscriptStore.load(workspaceId, runId).catch(() => null);
  if (!isLoopState(saved)) return null;
  const maxChars = loopLimitsFromEnv().toolResultMaxChars;
  const decided: DecidedProposal[] = decisions
    .filter((d) => d.call.toolUseId)
    .map((d) => ({
      call: d.call,
      exec: d.exec,
      result:
        d.exec.status === "cancelled" && !d.result
          ? { type: "tool_result", toolUseId: d.call.toolUseId!, content: `Not run: ${d.exec.resultSummary ?? "the user declined it"}. Carry on without it.`, isError: true }
          : toolResultFor(d.call.toolUseId!, d.exec, d.result, maxChars),
    }));
  const next = patchDecidedProposals(saved, decided, Date.now());
  if (!next) return null;
  await prismaTranscriptStore.save(workspaceId, runId, next, next.steps);
  return next;
}

/**
 * The user decided on a waiting child's proposals: patch its transcript and
 * resume it (its `subagent_run` job is queued again; it carries on from its
 * own transcript as its own agent, inside its own grant).
 */
export async function resumeChildAfterDecision(workspaceId: string, childRunId: string, decisions: readonly ProposalDecision[]): Promise<boolean> {
  const run = await getAgentRun(workspaceId, childRunId);
  const by = run ? readDelegatedBy(run.agentState) : null;
  if (!run || !by || String(run.status) !== "awaiting_confirmation") return false;
  const patched = await patchRunWithDecisions(workspaceId, childRunId, decisions);
  if (!patched) return false;
  await settleDelegation(workspaceId, by.parentRunId, { planId: by.planId, taskId: by.taskId, status: "running", resume: true });
  return true;
}

/** Finish runs Stop asked to end that nothing is running (waiting for the user or for sub-agents). */
export async function finishIdleStoppedRuns(workspaceId: string, runIds: readonly string[]): Promise<void> {
  const parents = new Set<string>();
  for (const id of runIds) {
    const run = await getAgentRun(workspaceId, id).catch(() => null);
    if (!run) continue;
    const status = String(run.status);
    const by = readDelegatedBy(run.agentState);
    if (by) parents.add(by.parentRunId);
    if (status === "awaiting_confirmation") {
      await finishAgentRun(workspaceId, id, "cancelled").catch(() => undefined);
    } else if (status === "running") {
      const d = await getDelegation(workspaceId, id).catch(() => null);
      if (d?.state?.plans.some((p) => !p.joinedAt)) {
        // It waits on its children: they were stopped with it; nothing runs it.
        const jobs = await withWorkspaceScope(workspaceId, (tx) =>
          tx.agentJob.count({ where: { workspaceId, runId: id, status: "running", kind: { in: ["chat_turn", "subagent_run", "delegation_join"] } } }),
        );
        if (jobs === 0) await finishAgentRun(workspaceId, id, "cancelled").catch(() => undefined);
      }
    }
  }
  for (const id of runIds) parents.add(id);
  for (const parentRunId of parents) await settleDelegation(workspaceId, parentRunId).catch(() => undefined);
}

/** The lead / sub-agent prompt layer for delegation (roles.ts holds the role prompts). */
export function delegationPromptSection(opts: { autoDelegation: boolean; canDelegate: boolean; nudge?: string | null }): string {
  if (!opts.canDelegate) return "";
  return [opts.autoDelegation ? DELEGATION_GUIDANCE : "", opts.nudge ? `Note on this request: ${opts.nudge}` : ""].filter(Boolean).join("\n");
}

export { DELIVERABLE_INSTRUCTIONS };

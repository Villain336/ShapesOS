// Marketr — Phase 9 M2: Chief Strategy Agent run loop (SPEC §P9A).
//
// One orchestrator per workspace. It does not do the work; it routes,
// sequences, and verifies.
//
// Determinism at the seams (research synthesis items 1–4):
//   - Explicit routing state: EVERY delegation records { nextAgent,
//     routingReason } in the mission event log — never "collaborate when
//     useful". Known task kinds route via ROUTING_TABLE; an injectable
//     novel-task router handles the rest (default: escalate to the human,
//     never guess).
//   - Deterministic termination, checked in CODE each hop: max steps,
//     timeout, per-mission cost budget, loop detection (same
//     nextAgent+reason 3x in a row), consecutive failures. Never "the LLM
//     says it's done".
//   - Circuit breaker: hard cap ~20 routing hops per run; on trip the
//     mission is paused and an escalation event is appended for the human.
//   - Workers receive CLEAN CONTEXT PACKETS (executors call
//     substrate.context with a task-scoped query); summaries return
//     upstream via dispatch results.

import { pauseMission as ksPauseMission, isWorkspaceFrozen, isMissionPaused, KillSwitchError } from "./killswitch";
import { appendMissionEvent, type MissionEventInput } from "./audit";
import { runResearcher } from "./executors/researcher";
import { runPlanner, type MissionPlan } from "./executors/planner";
import { runDrafter } from "./executors/drafter";
import { runAnalyst } from "./executors/analyst";
import { runScheduler } from "./executors/scheduler";
import { runActor } from "./executors/actor";

/** Circuit breaker: hard cap on routing hops per run (research: ~15–25). */
export const MAX_ROUTING_HOPS = 20;
/** Default caps — deterministic termination, checked each hop. */
export const DEFAULT_MAX_STEPS = 40;
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
export const DEFAULT_TIMEOUT_MS = 600_000; // 10 min
export const DEFAULT_COST_BUDGET_CENTS = 10_000; // $100 (illustrative; no marketing standard exists)

export type ExecutorName = "researcher" | "planner" | "drafter" | "analyst" | "scheduler" | "actor";

/**
 * ROUTING_TABLE — known task kinds map to executors. Routing TABLES, not
 * LLM judgment, for known task types; the novel-task router (injected,
 * default = escalate) handles the rest.
 */
export const ROUTING_TABLE: Readonly<Record<string, ExecutorName>> = Object.freeze({
  research: "researcher",
  investigate: "researcher",
  gather: "researcher",
  plan: "planner",
  sequence: "planner",
  design: "planner",
  draft: "drafter",
  write: "drafter",
  compose: "drafter",
  outreach: "drafter",
  content: "drafter",
  brief: "drafter",
  analyze: "analyst",
  attribute: "analyst",
  learn: "analyst",
  review: "analyst",
  schedule: "scheduler",
  timeline: "scheduler",
  remind: "scheduler",
  checkpoint: "scheduler",
  // Phase 14: connected-app actions (Chief Strategy Agent's hands).
  // The actor routes through the action gate — reads/draft-creators run
  // logged, writes/destructive land in the approve/deny queue.
  act: "actor",
  action: "actor",
  "tool-call": "actor",
});

/** Reverse lookup for plan steps -> task kinds. */
const EXECUTOR_TO_KIND: Readonly<Record<ExecutorName, string>> = Object.freeze({
  researcher: "research",
  planner: "plan",
  drafter: "draft",
  analyst: "analyze",
  scheduler: "schedule",
  actor: "act",
});

export interface MissionTask {
  kind: string;
  label: string;
  workspaceId: string;
  missionId?: string | null;
  payload?: Record<string, unknown>;
}

export interface RoutingRecord {
  nextAgent: ExecutorName;
  routingReason: string;
}

export interface DispatchResult {
  summary: string;
  costCents: number;
  followUps?: MissionTask[];
}

export type RunStatus = "complete" | "terminated" | "escalated" | "paused";

export type TerminationCode =
  | "queue_drained"
  | "max_steps"
  | "timeout"
  | "cost_budget"
  | "loop_detected"
  | "consecutive_failures"
  | "circuit_breaker"
  | "unknown_task_kind"
  | "mission_paused";

export interface RunMissionOptions {
  missionId: string;
  workspaceId: string;
  initialTasks: MissionTask[];
  maxSteps?: number;
  timeoutMs?: number;
  costBudgetCents?: number;
  maxRoutingHops?: number;
  maxConsecutiveFailures?: number;
  deps?: OrchestratorDeps;
}

export interface OrchestratorDeps {
  dispatch?: (executor: ExecutorName, task: MissionTask) => Promise<DispatchResult>;
  appendEvent?: (input: MissionEventInput) => Promise<unknown>;
  isWorkspaceFrozen?: (workspaceId: string) => Promise<boolean> | boolean;
  isMissionPaused?: (missionId: string, workspaceId: string) => Promise<boolean> | boolean;
  pauseMission?: (missionId: string, workspaceId: string, actor?: string) => Promise<void>;
  /** Novel task kinds: return a routing decision, or null to escalate. Default: escalate (never guess). */
  routeNovelTask?: (task: MissionTask) => Promise<RoutingRecord | null>;
  clock?: () => number;
}

export interface RunMissionResult {
  status: RunStatus;
  reason: TerminationCode;
  steps: number;
  hops: number;
  costCents: number;
}

/**
 * Default dispatch: real executors, each receiving a task-scoped input.
 * The planner's validated plan fans out into follow-up tasks.
 */
async function defaultDispatch(executor: ExecutorName, task: MissionTask): Promise<DispatchResult> {
  const base = { workspaceId: task.workspaceId, missionId: task.missionId ?? null };
  const p = task.payload ?? {};
  switch (executor) {
    case "researcher": {
      const r = await runResearcher({
        ...base,
        query: String(p.query ?? task.label),
        topK: typeof p.topK === "number" ? p.topK : undefined,
      });
      return { summary: r.summary, costCents: r.costCents };
    }
    case "planner": {
      const r = await runPlanner({ ...base, goal: String(p.goal ?? task.label) });
      return { summary: r.summary, costCents: r.costCents, followUps: planToTasks(r.plan, task) };
    }
    case "drafter": {
      const r = await runDrafter({
        ...base,
        brief: String(p.brief ?? task.label),
        artifactKind: (p.artifactKind as "outreach" | "brief" | "content" | undefined) ?? "content",
        channel: typeof p.channel === "string" ? p.channel : undefined,
        audience: typeof p.audience === "string" ? p.audience : undefined,
      });
      return { summary: r.summary, costCents: r.costCents };
    }
    case "analyst": {
      const r = await runAnalyst({
        ...base,
        hypothesis: String(p.hypothesis ?? task.label),
        action: String(p.action ?? task.label),
        result: (p.result as "worked" | "failed" | "inconclusive" | undefined) ?? "inconclusive",
        metricDelta: (p.metricDelta as Record<string, unknown> | undefined) ?? {},
        contextRefs: (p.contextRefs as Record<string, unknown> | undefined) ?? {},
      });
      return { summary: r.attribution, costCents: r.costCents };
    }
    case "scheduler": {
      // The scheduler schedules a plan's checkpoints. planToTasks hands it the validated plan;
      // a task without one fails with a plain reason rather than a TypeError deep inside.
      if (!p.plan || typeof p.plan !== "object") {
        throw new Error("scheduler: this task carries no mission plan to schedule checkpoints for.");
      }
      const r = await runScheduler({
        ...base,
        plan: p.plan as MissionPlan,
        startAt: typeof p.startAt === "string" ? p.startAt : undefined,
      });
      return { summary: r.summary, costCents: r.costCents };
    }
    case "actor": {
      const r = await runActor({
        ...base,
        appKey: String(p.appKey ?? ""),
        toolName: String(p.toolName ?? ""),
        args: (p.args as Record<string, unknown> | undefined) ?? {},
        invokedBy: `chief-strategy-agent${base.missionId ? `:${base.missionId}` : ""}`,
      });
      return { summary: r.summary, costCents: r.costCents };
    }
  }
}

export function planToTasks(plan: MissionPlan, parent: MissionTask): MissionTask[] {
  return plan.steps.map((s) => ({
    kind: EXECUTOR_TO_KIND[s.executor as ExecutorName] ?? "plan",
    label: `${s.id}: ${s.task}`,
    workspaceId: parent.workspaceId,
    missionId: parent.missionId ?? null,
    // The scheduler step proposes checkpoints for the plan it belongs to, so it carries that plan.
    payload: {
      ...(s.inputs as Record<string, unknown>),
      ...(s.executor === "scheduler" ? { plan } : {}),
      stepId: s.id,
    },
  }));
}

function routeTask(
  task: MissionTask,
  routeNovelTask: (task: MissionTask) => Promise<RoutingRecord | null>,
): Promise<RoutingRecord | null> {
  const hit = ROUTING_TABLE[task.kind];
  if (hit) {
    return Promise.resolve({
      nextAgent: hit,
      routingReason: `routing-table: task kind "${task.kind}" -> ${hit}`,
    });
  }
  return routeNovelTask(task);
}

/**
 * runMission — the Chief Strategy Agent run loop. Deterministic at every
 * seam: routing state recorded per delegation, termination checked in
 * code each hop, circuit breaker at MAX_ROUTING_HOPS.
 */
export async function runMission(opts: RunMissionOptions): Promise<RunMissionResult> {
  const { missionId, workspaceId } = opts;
  if (!missionId || !workspaceId) throw new Error("runMission: missionId and workspaceId are required.");

  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const costBudgetCents = opts.costBudgetCents ?? DEFAULT_COST_BUDGET_CENTS;
  const maxHops = opts.maxRoutingHops ?? MAX_ROUTING_HOPS;
  const maxFailures = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  const deps = opts.deps ?? {};
  const dispatch = deps.dispatch ?? defaultDispatch;
  const appendEvent = deps.appendEvent ?? appendMissionEvent;
  const frozen = deps.isWorkspaceFrozen ?? isWorkspaceFrozen;
  const paused = deps.isMissionPaused ?? isMissionPaused;
  const doPause = deps.pauseMission ?? ksPauseMission;
  const routeNovelTask = deps.routeNovelTask ?? (async () => null); // default: escalate, never guess
  const clock = deps.clock ?? Date.now;

  const deadline = clock() + timeoutMs;
  const queue: MissionTask[] = [...opts.initialTasks];
  let steps = 0;
  let hops = 0;
  let spentCents = 0;
  let consecutiveFailures = 0;
  const recentRoutes: string[] = [];
  let status: RunStatus = "complete";
  let reason: TerminationCode = "queue_drained";

  const log = (input: Omit<MissionEventInput, "missionId" | "workspaceId">) =>
    appendEvent({ missionId, workspaceId, ...input });

  /** Escalate to the human: pause the mission + append an escalation event. */
  async function escalate(code: TerminationCode, detail: string): Promise<void> {
    await doPause(missionId, workspaceId, "chief-strategy-agent");
    await log({
      actor: "chief-strategy-agent",
      step: "escalate",
      observation: { terminationCode: code, detail, steps, hops, costCents: spentCents },
    });
    status = "escalated";
    reason = code;
  }

  async function terminate(code: TerminationCode, detail: string): Promise<void> {
    await log({
      actor: "chief-strategy-agent",
      step: "terminate",
      observation: { terminationCode: code, detail, steps, hops, costCents: spentCents },
    });
    status = "terminated";
    reason = code;
  }

  while (queue.length > 0) {
    // Kill switches checked EVERY hop — a frozen workspace throws (hard halt),
    // a paused mission stops the loop (normal stop).
    if (await frozen(workspaceId)) {
      throw new KillSwitchError(`runMission halted: workspace "${workspaceId}" is frozen.`);
    }
    if (await paused(missionId, workspaceId)) {
      status = "paused";
      reason = "mission_paused";
      break;
    }

    // Deterministic termination — checked in code, each hop.
    if (steps >= maxSteps) {
      await terminate("max_steps", `Step cap reached (${maxSteps}).`);
      break;
    }
    if (clock() >= deadline) {
      await terminate("timeout", `Run timeout reached (${timeoutMs}ms).`);
      break;
    }
    if (spentCents >= costBudgetCents) {
      await terminate("cost_budget", `Per-mission cost budget reached (${spentCents}¢ >= ${costBudgetCents}¢).`);
      break;
    }

    // Circuit breaker: hard hop cap — pause + escalate for the human.
    if (hops >= maxHops) {
      await escalate("circuit_breaker", `Routing hop cap tripped (${maxHops} hops) — possible runaway routing.`);
      break;
    }

    const task = queue.shift()!;
    const routing = await routeTask(task, routeNovelTask);
    if (!routing) {
      await escalate("unknown_task_kind", `No routing-table entry for task kind "${task.kind}" and no novel-task router decision.`);
      break;
    }

    // Loop detection: same nextAgent + routingReason + task 3x in a row.
    // The task identity is part of the key — sequential distinct tasks are
    // legitimate work, not a loop. Runaway fan-out with ever-changing
    // labels is the circuit breaker's job, not this detector's.
    const routeKey = `${routing.nextAgent}|${routing.routingReason}|${task.kind}|${task.label}`;
    recentRoutes.push(routeKey);
    if (recentRoutes.length > 3) recentRoutes.shift();
    if (recentRoutes.length === 3 && recentRoutes.every((k) => k === routeKey)) {
      await terminate("loop_detected", `Same routing 3x in a row: ${routing.nextAgent} (${routing.routingReason}).`);
      break;
    }

    // Explicit routing state recorded BEFORE dispatch.
    hops += 1;
    steps += 1;
    await log({
      actor: "chief-strategy-agent",
      step: `route.${hops}`,
      tool: routing.nextAgent,
      args: {
        taskKind: task.kind,
        taskLabel: task.label,
        nextAgent: routing.nextAgent,
        routingReason: routing.routingReason,
      },
    });

    try {
      const res = await dispatch(routing.nextAgent, task);
      consecutiveFailures = 0;
      spentCents += Math.max(0, Math.round(res.costCents));
      await log({
        actor: routing.nextAgent,
        step: `exec.${hops}`,
        tool: routing.nextAgent,
        observation: { summary: res.summary.slice(0, 2000), costCents: res.costCents },
        costCents: Math.max(0, Math.round(res.costCents)),
      });
      if (res.followUps && res.followUps.length > 0) queue.push(...res.followUps);
    } catch (err) {
      consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      await log({
        actor: routing.nextAgent,
        step: `exec.${hops}.error`,
        tool: routing.nextAgent,
        observation: { error: message, consecutiveFailures },
      });
      if (consecutiveFailures >= maxFailures) {
        await escalate("consecutive_failures", `${maxFailures} consecutive executor failures (last: ${message.slice(0, 200)}).`);
        break;
      }
    }
  }

  if (status === "complete" && reason === "queue_drained") {
    await log({
      actor: "chief-strategy-agent",
      step: "complete",
      observation: { steps, hops, costCents: spentCents },
    });
  }

  return { status, reason, steps, hops, costCents: spentCents };
}

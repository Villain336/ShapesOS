// ShapesOS — Phase 16: automatic delegation, the pure half (no prisma, no I/O).
//
// The lead (or a sub-agent with the opt-in `delegate` group) hands a plan to
// delegate_tasks: { goal, tasks: [{ id, agent, brief, tools?, dependsOn?,
// deliverable, budgetShare? }], mergeInstructions }. Everything that can be
// decided without the database lives here and is unit-tested:
//
//   * the plan schema (zod, modelled on MissionPlanSchema in
//     lib/orchestrator/executors/planner.ts: ids, dependsOn edges that must
//     point at real tasks) plus what a plan may never be: cyclic, wider than
//     the width cap, deeper than the depth cap, aimed at an unknown agent or
//     at the lead itself;
//   * the fix-round rule: after a plan joins, the lead may re-delegate at most
//     ONE fix task per failed / stopped task (and nothing else);
//   * the budget split: each child reserves its share (budgetShare, or an
//     even split of what's left) of the parent's remaining cost / steps /
//     time after a reserve for the merge; Σ children ≤ pool ≤ what was left,
//     so siblings can never overspend together; unused budget returns on join;
//   * scheduling: which tasks may start now (dependencies succeeded, under the
//     per-run and per-workspace caps), which can never start (a prerequisite
//     failed → skipped);
//   * the child's brief (with its prerequisites' deliverables, truncated), the
//     structured deliverable it returns, and the merge report the lead gets
//     back at the join — which lists EVERY task, failed and stopped ones too.

import { z } from "zod";
import { SUB_AGENTS, type SubAgentKey } from "@/lib/aos/agents";

// ── limits ──────────────────────────────────────────────────────────────────

export interface DelegationLimits {
  /** Sub-agents of one run working at the same time. */
  maxParallelPerRun: number;
  /** Delegated sub-agents working at the same time across the workspace. */
  maxLivePerWorkspace: number;
  /** Tasks in one plan. */
  maxWidth: number;
  /** Levels below the lead (2 = a sub-agent may hand work down once more). */
  maxDepth: number;
}

export const DEFAULT_DELEGATION_LIMITS: Readonly<DelegationLimits> = Object.freeze({
  maxParallelPerRun: 4,
  maxLivePerWorkspace: 6,
  maxWidth: 8,
  maxDepth: 2,
});

/** What a workspace may set each limit to (the settings API enforces these). */
export const DELEGATION_LIMIT_BOUNDS: Readonly<Record<keyof DelegationLimits, readonly [number, number]>> = Object.freeze({
  maxParallelPerRun: [1, 8] as const,
  maxLivePerWorkspace: [1, 32] as const,
  maxWidth: [1, 16] as const,
  maxDepth: [1, 2] as const,
});

function clampInt(v: unknown, [lo, hi]: readonly [number, number], fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null;
  if (n === null) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** A workspace's stored overrides (null = code default) → the limits in force. */
export function effectiveDelegationLimits(row?: Partial<Record<keyof DelegationLimits, number | null>> | null): DelegationLimits {
  const out = { ...DEFAULT_DELEGATION_LIMITS };
  for (const k of Object.keys(DEFAULT_DELEGATION_LIMITS) as Array<keyof DelegationLimits>) {
    out[k] = clampInt(row?.[k] ?? null, DELEGATION_LIMIT_BOUNDS[k], DEFAULT_DELEGATION_LIMITS[k]);
  }
  return out;
}

// ── the plan ────────────────────────────────────────────────────────────────

export const SUB_AGENT_KEYS = Object.keys(SUB_AGENTS) as SubAgentKey[];

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export const DelegationTaskSchema = z.object({
  id: z.string().regex(TASK_ID_RE, "task ids are 1–40 letters, digits, _ or -"),
  agent: z.string().trim().min(1),
  brief: z.string().trim().min(1).max(4000),
  /** Tool groups to narrow the sub-agent to (never wider than the parent). */
  tools: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
  dependsOn: z.array(z.string()).max(16).default([]),
  /** What the sub-agent must hand back. */
  deliverable: z.string().trim().min(1).max(1000),
  /** Fraction of the parent's splittable budget (0 < share ≤ 1); default an even split. */
  budgetShare: z.number().gt(0).max(1).optional(),
  /** A fix round: the id of the failed task this one retries. */
  fixes: z.string().trim().min(1).max(40).optional(),
});

export const DelegationPlanSchema = z
  .object({
    goal: z.string().trim().min(1).max(2000),
    tasks: z.array(DelegationTaskSchema).min(1),
    mergeInstructions: z.string().trim().min(1).max(4000),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const t of plan.tasks) {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", message: `Task id "${t.id}" is used twice.` });
      ids.add(t.id);
    }
    for (const t of plan.tasks) {
      if (t.agent === "lead") ctx.addIssue({ code: "custom", message: `Task "${t.id}": the lead can't be delegated to; pick a sub-agent.` });
      else if (!(SUB_AGENT_KEYS as string[]).includes(t.agent)) {
        ctx.addIssue({ code: "custom", message: `Task "${t.id}": unknown agent "${t.agent}" (use one of ${SUB_AGENT_KEYS.join(", ")}).` });
      }
      for (const d of t.dependsOn) {
        if (d === t.id) ctx.addIssue({ code: "custom", message: `Task "${t.id}" depends on itself.` });
        else if (!ids.has(d)) ctx.addIssue({ code: "custom", message: `Task "${t.id}" depends on unknown task "${d}".` });
      }
    }
    const shares = plan.tasks.reduce((n, t) => n + (t.budgetShare ?? 0), 0);
    if (shares > 1 + 1e-9) ctx.addIssue({ code: "custom", message: `Budget shares add up to ${shares.toFixed(2)}; they must not exceed 1.` });
    const cycle = findCycle(plan.tasks);
    if (cycle) ctx.addIssue({ code: "custom", message: `Tasks depend on each other in a cycle: ${cycle.join(" → ")}.` });
  });

export type DelegationPlanInput = z.input<typeof DelegationPlanSchema>;
export type DelegationPlan = z.infer<typeof DelegationPlanSchema>;
export type DelegationTask = z.infer<typeof DelegationTaskSchema>;

/** A dependency cycle (ids, first repeated at the end), or null. Ignores dangling edges. */
export function findCycle(tasks: ReadonlyArray<{ id: string; dependsOn?: readonly string[] }>): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, (t.dependsOn ?? []).filter((d) => d !== t.id)]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const s = state.get(d) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (s === 0) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const t of tasks) {
    if ((state.get(t.id) ?? 0) === 0) {
      const c = visit(t.id);
      if (c) return c;
    }
  }
  return null;
}

/** Task ids in an order where every task comes after what it depends on (plan order on ties). */
export function dependencyOrder(tasks: ReadonlyArray<{ id: string; dependsOn?: readonly string[] }>): string[] {
  const done = new Set<string>();
  const out: string[] = [];
  const known = new Set(tasks.map((t) => t.id));
  while (out.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.id) && (t.dependsOn ?? []).every((d) => done.has(d) || !known.has(d)));
    if (!next) break; // a cycle: validation refuses those
    done.add(next.id);
    out.push(next.id);
  }
  return out;
}

export interface PlanValidationContext {
  limits: DelegationLimits;
  /** Depth of the run that delegates (the lead is 0). */
  depth: number;
  /** Plans this run already delegated (a later plan must be a fix round). */
  previous?: ReadonlyArray<Pick<DelegationPlanState, "planId" | "tasks">>;
}

export type PlanValidation = { ok: true; plan: DelegationPlan } | { ok: false; errors: string[] };

/** Validate a plan the model sent (schema, caps, fix-round rules). PURE. */
export function validateDelegationPlan(raw: unknown, vctx: PlanValidationContext): PlanValidation {
  const parsed = DelegationPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 8).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)) };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  if (plan.tasks.length > vctx.limits.maxWidth) {
    errors.push(`The plan has ${plan.tasks.length} tasks; at most ${vctx.limits.maxWidth} sub-agents may work on one plan. Merge small tasks or keep them inline.`);
  }
  if (vctx.depth + 1 > vctx.limits.maxDepth) {
    errors.push(`Sub-agents at this level can't hand work further down (the depth limit is ${vctx.limits.maxDepth}). Do the work yourself.`);
  }
  const previous = vctx.previous ?? [];
  if (previous.length > 0) {
    // After the first plan, only a fix round: one retry per failed task.
    const failed = new Map<string, DelegationTaskState>();
    const alreadyFixed = new Set<string>();
    for (const p of previous) {
      for (const t of p.tasks) {
        if (t.fixes) alreadyFixed.add(t.fixes);
        if ((t.status === "failed" || t.status === "cancelled" || t.status === "skipped") && !t.fixes) failed.set(t.id, t);
      }
    }
    const seen = new Set<string>();
    for (const t of plan.tasks) {
      if (!t.fixes) {
        errors.push(`Task "${t.id}": a second plan may only retry failed tasks — set fixes to the failed task's id, or do this part yourself.`);
        continue;
      }
      if (!failed.has(t.fixes)) errors.push(`Task "${t.id}": "${t.fixes}" is not a failed or stopped task from the earlier plan.`);
      else if (alreadyFixed.has(t.fixes) || seen.has(t.fixes)) errors.push(`Task "${t.id}": "${t.fixes}" was already retried once.`);
      seen.add(t.fixes);
      if (t.dependsOn.length) errors.push(`Task "${t.id}": a fix task can't depend on other tasks.`);
    }
  } else {
    for (const t of plan.tasks) if (t.fixes) errors.push(`Task "${t.id}": fixes is only for retrying a failed task of an earlier plan.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

// ── the budget split ────────────────────────────────────────────────────────

export interface Budget {
  /** Estimated model cost, micro-USD. */
  costMicroUsd: number;
  /** Model calls. */
  steps: number;
  /** Wall-clock time of active work, ms. */
  ms: number;
}

/** Part of what's left the parent keeps for checking and merging the results. */
export const MERGE_RESERVE_SHARE = 0.2;
/** A child needs at least this much to do anything useful. */
export const MIN_CHILD_BUDGET: Readonly<Budget> = Object.freeze({ costMicroUsd: 1_000, steps: 2, ms: 30_000 });

export interface BudgetSplit {
  reserve: Budget;
  /** What the children share (left − reserve). */
  pool: Budget;
  perTask: Record<string, Budget>;
  /** Normalised share per task. */
  shares: Record<string, number>;
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Split the parent's remaining budget. Explicit shares first; tasks without
 * one split the rest evenly. Every amount is floored, so Σ perTask ≤ pool ≤
 * left on every axis. Errors when a child would get less than MIN_CHILD_BUDGET.
 */
export function splitBudget(
  left: Budget,
  tasks: ReadonlyArray<{ id: string; budgetShare?: number }>,
  /**
   * Phase 19A: what is left of the run's USER-SET spend cap (micro-USD;
   * null/undefined = none). The children's cost shares are taken from at
   * most this, so together they never exceed it; when it is used up the
   * split is refused with a plain reason (the caller records a run event).
   */
  opts: { capLeftMicroUsd?: number | null } = {},
): { ok: true; split: BudgetSplit } | { ok: false; error: string; capExhausted?: true } {
  const cap = opts.capLeftMicroUsd;
  const hasCap = cap !== undefined && cap !== null;
  if (hasCap && nonNeg(cap) < MIN_CHILD_BUDGET.costMicroUsd * Math.max(1, tasks.length) / (1 - MERGE_RESERVE_SHARE)) {
    return {
      ok: false,
      capExhausted: true,
      error:
        `The spend cap for this task is used up (≈$${(nonNeg(cap) / 1_000_000).toFixed(3)} left), so no sub-agents were started. ` +
        "Finish with what you have, or ask the person to raise the cap.",
    };
  }
  const l = {
    costMicroUsd: hasCap ? Math.min(nonNeg(left.costMicroUsd), nonNeg(cap)) : nonNeg(left.costMicroUsd),
    steps: Math.floor(nonNeg(left.steps)),
    ms: nonNeg(left.ms),
  };
  const reserve: Budget = {
    costMicroUsd: Math.ceil(l.costMicroUsd * MERGE_RESERVE_SHARE),
    steps: Math.max(1, Math.ceil(l.steps * MERGE_RESERVE_SHARE)),
    ms: Math.ceil(l.ms * MERGE_RESERVE_SHARE),
  };
  const pool: Budget = {
    costMicroUsd: Math.max(0, l.costMicroUsd - reserve.costMicroUsd),
    steps: Math.max(0, l.steps - reserve.steps),
    ms: Math.max(0, l.ms - reserve.ms),
  };
  const explicit = tasks.reduce((n, t) => n + (t.budgetShare ?? 0), 0);
  const unshared = tasks.filter((t) => t.budgetShare === undefined).length;
  const evenShare = unshared > 0 ? Math.max(0, 1 - Math.min(1, explicit)) / unshared : 0;
  const shares: Record<string, number> = {};
  const perTask: Record<string, Budget> = {};
  for (const t of tasks) {
    const share = t.budgetShare ?? evenShare;
    shares[t.id] = share;
    perTask[t.id] = {
      costMicroUsd: Math.floor(pool.costMicroUsd * share),
      steps: Math.floor(pool.steps * share),
      ms: Math.floor(pool.ms * share),
    };
    const b = perTask[t.id]!;
    if (b.steps < MIN_CHILD_BUDGET.steps || b.costMicroUsd < MIN_CHILD_BUDGET.costMicroUsd || b.ms < MIN_CHILD_BUDGET.ms) {
      return {
        ok: false,
        error:
          `Not enough budget left to split ${tasks.length} way${tasks.length === 1 ? "" : "s"}: task "${t.id}" would get ` +
          `${b.steps} model calls, ≈$${(b.costMicroUsd / 1_000_000).toFixed(3)} and ${Math.round(b.ms / 1000)}s. ` +
          "Use fewer tasks, give it a bigger share, or do the work yourself.",
      };
    }
  }
  return { ok: true, split: { reserve, pool, perTask, shares } };
}

export interface JoinAccounting {
  reserved: Budget;
  used: Budget;
  /** Reserved but not used: back with the parent. */
  returned: Budget;
}

/** What the children reserved, used and gave back (a child never reports more than it used). */
export function joinAccounting(tasks: ReadonlyArray<Pick<DelegationTaskState, "budget" | "costMicroUsd" | "steps" | "activeMs">>): JoinAccounting {
  const sum = (f: (t: (typeof tasks)[number]) => number) => tasks.reduce((n, t) => n + nonNeg(f(t)), 0);
  const reserved = { costMicroUsd: sum((t) => t.budget.costMicroUsd), steps: sum((t) => t.budget.steps), ms: sum((t) => t.budget.ms) };
  const used = { costMicroUsd: sum((t) => t.costMicroUsd ?? 0), steps: sum((t) => t.steps ?? 0), ms: sum((t) => t.activeMs ?? 0) };
  return {
    reserved,
    used,
    returned: {
      costMicroUsd: Math.max(0, reserved.costMicroUsd - used.costMicroUsd),
      steps: Math.max(0, reserved.steps - used.steps),
      ms: Math.max(0, reserved.ms - used.ms),
    },
  };
}

// ── task state + scheduling ─────────────────────────────────────────────────

export type DelegationTaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export const TERMINAL_TASK_STATUSES: ReadonlySet<DelegationTaskStatus> = new Set(["succeeded", "failed", "cancelled", "skipped"]);
export const LIVE_TASK_STATUSES: ReadonlySet<DelegationTaskStatus> = new Set(["queued", "running"]);

export interface Deliverable {
  summary: string;
  outputs: string;
  artifacts: string[];
  openIssues: string[];
  confidence: "high" | "medium" | "low" | "unknown";
}

export interface DelegationTaskState {
  id: string;
  agent: SubAgentKey;
  brief: string;
  deliverableSpec: string;
  dependsOn: string[];
  requestedTools: string[] | null;
  /** The server-computed grant (never wider than the parent's). */
  grant: string[];
  /** Requested groups that were dropped (unknown or beyond the parent). */
  dropped: string[];
  budgetShare: number;
  budget: Budget;
  fixes?: string;
  status: DelegationTaskStatus;
  childRunId?: string;
  startedAt?: string;
  endedAt?: string;
  deliverable?: Deliverable;
  error?: string;
  /** What the child actually used (set when it settles). */
  costMicroUsd?: number;
  steps?: number;
  activeMs?: number;
  /** Pending proposals while awaiting_confirmation (ChatToolCall records). */
  proposals?: unknown[];
}

export interface DelegationPlanState {
  planId: string;
  /** The delegate_tasks tool_use id in the parent's transcript (the join patches its result). */
  toolUseId: string;
  goal: string;
  mergeInstructions: string;
  /** Depth of the children (the lead's children are 1). */
  depth: number;
  /** 0 = the first plan, 1 = the fix round. */
  round: number;
  createdAt: string;
  /** Children start only once the parent saved its waiting state. */
  armed: boolean;
  reserve: Budget;
  tasks: DelegationTaskState[];
  /** Set once, under the parent row lock, with the continuation job (the join). */
  joinedAt?: string;
  joinJobId?: string;
  /** Proposal set already posted to the thread (no double posting). */
  approvalsPostedKey?: string;
}

/** Tasks that may start now: pending, every prerequisite succeeded. Plan order. */
export function readyTasks(tasks: readonly DelegationTaskState[]): DelegationTaskState[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => byId.get(d)?.status === "succeeded"));
}

/** Pending tasks that can never start: a prerequisite failed, was stopped or skipped. */
export function doomedTasks(tasks: readonly DelegationTaskState[]): Array<{ task: DelegationTaskState; because: string }> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: Array<{ task: DelegationTaskState; because: string }> = [];
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const bad = t.dependsOn.find((d) => {
      const s = byId.get(d)?.status;
      return s === "failed" || s === "cancelled" || s === "skipped";
    });
    if (bad) out.push({ task: t, because: bad });
  }
  return out;
}

/**
 * Which ready tasks to start now, within the per-run and per-workspace caps.
 * `liveForRun` / `liveForWorkspace` count sub-agents already queued or running.
 */
export function tasksToStart(
  tasks: readonly DelegationTaskState[],
  caps: { liveForRun: number; liveForWorkspace: number; limits: DelegationLimits },
): DelegationTaskState[] {
  const room = Math.max(0, Math.min(caps.limits.maxParallelPerRun - caps.liveForRun, caps.limits.maxLivePerWorkspace - caps.liveForWorkspace));
  return readyTasks(tasks).slice(0, room);
}

export interface DelegationProgress {
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  running: number;
  needs: number;
  pending: number;
}

export function delegationProgress(tasks: readonly Pick<DelegationTaskState, "status">[]): DelegationProgress {
  const p: DelegationProgress = { total: tasks.length, done: 0, succeeded: 0, failed: 0, running: 0, needs: 0, pending: 0 };
  for (const t of tasks) {
    if (TERMINAL_TASK_STATUSES.has(t.status)) p.done++;
    if (t.status === "succeeded") p.succeeded++;
    else if (t.status === "failed" || t.status === "skipped" || t.status === "cancelled") p.failed++;
    else if (t.status === "running" || t.status === "queued") p.running++;
    else if (t.status === "awaiting_confirmation") p.needs++;
    else p.pending++;
  }
  return p;
}

/** "3 of 5 sub-agents done". */
export function progressLine(p: Pick<DelegationProgress, "done" | "total">): string {
  return `${p.done} of ${p.total} sub-agent${p.total === 1 ? "" : "s"} done`;
}

// ── briefs, deliverables, the merge ─────────────────────────────────────────

/** Characters of an earlier task's deliverable passed into a dependent brief. */
export const DEP_DELIVERABLE_CHARS = 1_500;
/** Characters of one task's outputs in the merge report. */
export const MERGE_OUTPUT_CHARS = 4_000;

export function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} characters]` : s;
}

/** The structured report every sub-agent ends with (its system prompt says so). */
export const DELIVERABLE_INSTRUCTIONS = [
  "## How to finish",
  "Do your task only. When you are done, end your final message with a fenced block tagged deliverable holding JSON:",
  "```deliverable",
  '{ "summary": "one or two sentences", "outputs": "the result itself (findings, draft, numbers)", "artifacts": ["ids, links or file paths you produced"], "openIssues": ["what you could not do or verify"], "confidence": "high | medium | low" }',
  "```",
  "Be honest in openIssues and confidence: the lead checks your work against what was asked.",
].join("\n");

const CONFIDENCE = new Set(["high", "medium", "low"]);

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v.trim()] : [];
  return v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim().slice(0, 500)).slice(0, 20);
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Read the child's deliverable from its final text: the ```deliverable (or a
 * ```json block with a "summary") block when there is one, else the text
 * itself as the output with unknown confidence. Never throws.
 */
export function parseDeliverable(finalText: string): Deliverable {
  const text = (finalText ?? "").trim();
  const blocks = [...text.matchAll(/```(deliverable|json)?\s*\n([\s\S]*?)```/g)];
  for (const m of blocks.reverse()) {
    const tag = m[1] ?? "";
    try {
      const v = JSON.parse(m[2]!) as Record<string, unknown>;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      if (tag !== "deliverable" && typeof v.summary !== "string") continue;
      const rest = text.replace(m[0], "").trim();
      const c = typeof v.confidence === "string" ? v.confidence.trim().toLowerCase() : typeof v.confidence === "number" ? (v.confidence >= 0.75 ? "high" : v.confidence >= 0.4 ? "medium" : "low") : "";
      const summary = typeof v.summary === "string" && v.summary.trim() ? v.summary.trim() : rest.slice(0, 300);
      return {
        summary: summary.slice(0, 1_000),
        outputs: (stringify(v.outputs).trim() || rest).slice(0, 20_000),
        artifacts: strList(v.artifacts),
        openIssues: strList(v.openIssues),
        confidence: CONFIDENCE.has(c) ? (c as Deliverable["confidence"]) : "unknown",
      };
    } catch {
      // not JSON: try the next block, then fall back
    }
  }
  return {
    summary: (text.split(/\n\s*\n/)[0] ?? "").slice(0, 300) || "(no report)",
    outputs: text.slice(0, 20_000),
    artifacts: [],
    openIssues: [],
    confidence: "unknown",
  };
}

function agentName(agent: string): string {
  return (SUB_AGENTS as Record<string, { name: string }>)[agent]?.name ?? agent;
}

/** The first user message a child gets: its brief, the expected deliverable and its prerequisites' results. */
export function childBriefMessage(input: {
  goal: string;
  task: Pick<DelegationTaskState, "id" | "brief" | "deliverableSpec" | "dependsOn" | "budget">;
  prerequisites: ReadonlyArray<Pick<DelegationTaskState, "id" | "agent" | "deliverable">>;
}): string {
  const { task } = input;
  const lines = [
    `Task ${task.id} of the plan "${truncateText(input.goal, 300)}".`,
    "",
    task.brief,
    "",
    `Hand back: ${task.deliverableSpec}`,
    `Your budget: about ${task.budget.steps} model calls, ≈$${(task.budget.costMicroUsd / 1_000_000).toFixed(2)}, ${Math.max(1, Math.round(task.budget.ms / 60_000))} min.`,
  ];
  if (input.prerequisites.length) {
    lines.push("", "## Results you build on (from earlier tasks)");
    for (const p of input.prerequisites) {
      const d = p.deliverable;
      lines.push(
        "",
        `### ${p.id} (${agentName(p.agent)})`,
        d ? `Summary: ${d.summary}` : "Summary: (none)",
        d ? truncateText(d.outputs, DEP_DELIVERABLE_CHARS) : "",
      );
    }
  }
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

const STATUS_WORD: Record<DelegationTaskStatus, string> = {
  pending: "NOT STARTED",
  queued: "NOT STARTED",
  running: "STILL RUNNING",
  awaiting_confirmation: "WAITING FOR APPROVAL",
  succeeded: "succeeded",
  failed: "FAILED",
  cancelled: "STOPPED",
  skipped: "SKIPPED",
};

export const PLAN_RESULT_MARKER = "[delegation plan result]";

/**
 * What the delegating agent reads at the join (it replaces the delegate_tasks
 * placeholder result): every task with its status and deliverable — failed,
 * stopped and skipped ones included — then how to verify and merge.
 */
export function joinReport(plan: Pick<DelegationPlanState, "planId" | "goal" | "mergeInstructions" | "tasks" | "round">): string {
  const p = delegationProgress(plan.tasks);
  const acct = joinAccounting(plan.tasks);
  const out: string[] = [
    `${PLAN_RESULT_MARKER} ${plan.planId}: ${p.succeeded} of ${p.total} task${p.total === 1 ? "" : "s"} succeeded${p.failed ? `, ${p.failed} did not` : ""}.`,
    `Goal: ${plan.goal}`,
    `Budget: the sub-agents used ≈$${(acct.used.costMicroUsd / 1_000_000).toFixed(3)} of ≈$${(acct.reserved.costMicroUsd / 1_000_000).toFixed(3)} reserved and ${acct.used.steps} of ${acct.reserved.steps} model calls; the rest is back with you.`,
  ];
  for (const t of plan.tasks) {
    const d = t.deliverable;
    out.push(
      "",
      `## Task ${t.id} — ${agentName(t.agent)} — ${STATUS_WORD[t.status]}${d && t.status === "succeeded" ? ` (confidence ${d.confidence})` : ""}${t.fixes ? ` — retry of ${t.fixes}` : ""}`,
      `Asked: ${truncateText(t.brief, 400)}`,
      `Expected: ${t.deliverableSpec}`,
    );
    if (t.error) out.push(`What went wrong: ${t.error}`);
    if (d) {
      out.push(`Summary: ${d.summary}`, "Outputs:", truncateText(d.outputs, MERGE_OUTPUT_CHARS));
      if (d.artifacts.length) out.push(`Artifacts: ${d.artifacts.join(", ")}`);
      if (d.openIssues.length) out.push(`Open issues: ${d.openIssues.join("; ")}`);
    }
  }
  const failed = plan.tasks.filter((t) => t.status === "failed" || t.status === "cancelled" || t.status === "skipped");
  out.push(
    "",
    "## Now",
    "1. Check each deliverable against what its task asked for (see Expected). Don't trust a report you can't reconcile with the data.",
    failed.length && plan.round === 0
      ? `2. You may retry each failed or stopped task at most once: call delegate_tasks again with one task per retry and fixes set to the failed task's id (${failed.map((t) => t.id).join(", ")}). Otherwise do the missing part yourself or say it is missing.`
      : "2. No more delegation for this plan: fill any gap yourself or say plainly what is missing.",
    `3. Merge and answer the user once, following these instructions: ${plan.mergeInstructions}`,
    "4. Report failed, stopped or skipped tasks honestly — never drop them silently.",
  );
  return out.join("\n");
}

/** The placeholder result the model never sees (replaced at the join). */
export function waitingPlaceholder(planId: string, n: number): string {
  return `${PLAN_RESULT_MARKER} ${planId}: waiting — ${n} sub-agent${n === 1 ? "" : "s"} working.`;
}

export function isWaitingPlaceholder(content: string, planId: string): boolean {
  return content.startsWith(`${PLAN_RESULT_MARKER} ${planId}: waiting`);
}

// ── the automatic trigger ───────────────────────────────────────────────────

const PARALLEL_RE = /\b(in parallel|at the same time|simultaneously|concurrently|split (?:this|it|the work)|fan(?:ned)? out|sub-?agents?|delegate)\b/i;
const LIST_ITEM_RE = /^\s*(?:[-*•]|\d+[.)])\s+\S/;

/**
 * A cheap pre-check on the user's message: does it look worth splitting?
 * Returns a one-line nudge for the lead's prompt, or null. The model decides.
 */
export function delegationNudge(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (PARALLEL_RE.test(t)) return "The user asked for the work to be split or run in parallel: plan it with delegate_tasks unless it is a single small step.";
  const items = t.split("\n").filter((l) => LIST_ITEM_RE.test(l)).length;
  if (items >= 3) return `The request lists ${items} separate items: if they are independent, consider handing them to sub-agents in parallel with delegate_tasks.`;
  const andCount = (t.match(/\b(and|then|also|plus)\b/gi) ?? []).length;
  if (t.length >= 600 && andCount >= 3) return "This is a long, multi-part request: consider whether independent parts should go to sub-agents in parallel with delegate_tasks.";
  return null;
}

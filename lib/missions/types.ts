// Marketr — Phase 9 M4: mission engine types + pure helpers (SPEC-PHASE9.md §P9C).
//
// PURE module — no prisma, no @/ alias imports, no I/O. Safe to import from
// tsx-run tests (lib/missions/__tests__). Mirrors the M1 pattern where the
// DoA tier evaluator stays pure and stores/deps are injected.

import { getTemplate, type GoalDirection } from "./templates";

export type MissionStatusName = "planned" | "active" | "paused" | "complete" | "archived";

export type ApprovalStatusName = "pending" | "approved" | "denied" | "expired" | "revoked" | "executed";

/** Goal as supplied by the API caller when starting a mission. */
export interface MissionGoalInput {
  metric: string;
  targetValue: number;
  unit?: string;
  timeframeDays: number;
  direction?: GoalDirection;
  baseline?: number;
}

export interface ValidatedGoal {
  metric: string;
  targetValue: number;
  unit: string;
  timeframeDays: number;
  direction: GoalDirection;
  baseline: number | null;
}

export class GoalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalValidationError";
  }
}

/** Validate the goal shape for POST /api/missions (Tier 0 — drafts plans, executes nothing). */
export function validateGoal(goal: unknown): ValidatedGoal {
  if (!goal || typeof goal !== "object") {
    throw new GoalValidationError("goal is required: { metric, targetValue, timeframeDays }.");
  }
  const g = goal as Record<string, unknown>;
  const metric = typeof g.metric === "string" ? g.metric.trim() : "";
  if (!metric) throw new GoalValidationError("goal.metric must be a non-empty string.");
  if (typeof g.targetValue !== "number" || !Number.isFinite(g.targetValue) || g.targetValue <= 0) {
    throw new GoalValidationError("goal.targetValue must be a positive number.");
  }
  if (typeof g.timeframeDays !== "number" || !Number.isInteger(g.timeframeDays) || g.timeframeDays < 1 || g.timeframeDays > 365) {
    throw new GoalValidationError("goal.timeframeDays must be an integer between 1 and 365.");
  }
  const direction = g.direction === undefined ? "increase" : g.direction;
  if (direction !== "increase" && direction !== "decrease") {
    throw new GoalValidationError('goal.direction must be "increase" or "decrease".');
  }
  const unit = typeof g.unit === "string" ? g.unit : "";
  const baseline =
    g.baseline === undefined || g.baseline === null
      ? null
      : typeof g.baseline === "number" && Number.isFinite(g.baseline)
        ? g.baseline
        : (() => {
            throw new GoalValidationError("goal.baseline must be a finite number when provided.");
          })();
  return { metric, targetValue: g.targetValue, unit, timeframeDays: g.timeframeDays, direction, baseline };
}

// ---------------------------------------------------------------------------
// Termination (spec §P9C: explicit termination conditions, checkable in code)
// ---------------------------------------------------------------------------

export interface TerminationConfig {
  maxSteps: number;
  maxCostCents: number;
  /** ISO timestamp — mission timeout. */
  deadlineAt: string;
  maxConsecutiveFailures: number;
  goal: { metric: string; targetValue: number; direction: GoalDirection };
}

export type TerminationReason =
  | "goal_met"
  | "step_limit"
  | "cost_budget"
  | "timeout"
  | "consecutive_failures";

export interface TerminationInput {
  goal: { metric: string; targetValue: number; direction: GoalDirection; currentValue?: number };
  maxSteps: number;
  stepCount: number;
  maxCostCents: number;
  totalCostCents: number;
  deadlineAt: string;
  maxConsecutiveFailures: number;
  consecutiveFailures: number;
  now?: Date;
}

/**
 * checkTermination — deterministic termination, in code, never "the LLM
 * says it's done" (research §6.2). goal_met is checked first so success
 * always wins over budget/step pressure.
 */
export function checkTermination(input: TerminationInput): { done: boolean; reason: TerminationReason | null } {
  const now = input.now ?? new Date();
  const dir: GoalDirection = input.goal.direction ?? "increase";
  const cv = input.goal.currentValue;
  if (cv !== undefined && Number.isFinite(cv)) {
    const met = dir === "decrease" ? cv <= input.goal.targetValue : cv >= input.goal.targetValue;
    if (met) return { done: true, reason: "goal_met" };
  }
  if (input.stepCount >= input.maxSteps) return { done: true, reason: "step_limit" };
  if (input.totalCostCents >= input.maxCostCents) return { done: true, reason: "cost_budget" };
  if (Number.isFinite(new Date(input.deadlineAt).getTime()) && now.getTime() >= new Date(input.deadlineAt).getTime()) {
    return { done: true, reason: "timeout" };
  }
  if (input.consecutiveFailures >= input.maxConsecutiveFailures) {
    return { done: true, reason: "consecutive_failures" };
  }
  return { done: false, reason: null };
}

// ---------------------------------------------------------------------------
// Step counting + progress
// ---------------------------------------------------------------------------

/** Event steps that are engine bookkeeping — never counted toward maxSteps. */
export const META_STEPS: ReadonlySet<string> = new Set([
  "mission.genesis",
  "mission.activated",
  "mission.completed",
  "mission.terminated",
  "checkpoint",
  "killswitch.pause",
  "killswitch.resume",
  "killswitch.resume_blocked",
  "approval.requested",
  "approval.decided",
]);

export function isCountedStep(step: string | null | undefined): boolean {
  return !!step && !META_STEPS.has(step);
}

/** Progress ∈ [0,1] over the template plan skeleton. */
export function missionProgress(planStepCount: number, stepCount: number, status: MissionStatusName): number {
  if (status === "complete") return 1;
  if (planStepCount <= 0) return 0;
  return Math.min(1, Math.max(0, stepCount / planStepCount));
}

// ---------------------------------------------------------------------------
// Checkpoints (spec §P9C: hybrid — after each step, before irreversible ops,
// at cost-budget fractions, after approvals, on error, time-based safety net)
// ---------------------------------------------------------------------------

export type CheckpointReason =
  | "after_step"
  | "before_irreversible"
  | "cost_budget_fraction"
  | "after_approval"
  | "on_error"
  | "time_safety_net"
  | "mission_start"
  | "manual";

export interface CheckpointSnapshot {
  at: string;
  status: MissionStatusName;
  stepCount: number;
  totalCostCents: number;
  pendingApprovals: number;
  consecutiveFailures: number;
}

export interface CheckpointRecord {
  reason: CheckpointReason;
  at: string;
  snapshot: CheckpointSnapshot;
}

// ---------------------------------------------------------------------------
// Staleness re-verification (spec §P9C; wires into M1's resumeMission hook)
// ---------------------------------------------------------------------------

/** Graph data older than this is "stale beyond tolerance" on resume. */
export const STALE_DATA_TOLERANCE_DAYS = 14;
/** Deadline may be exceeded by this grace before resume requires human review. */
export const RESUME_DEADLINE_GRACE_DAYS = 3;

export interface StalenessCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface MissionStalenessReport {
  fresh: boolean;
  checkedAt: string;
  checks: StalenessCheckResult[];
  note?: string;
}

/** Build the staleness report from already-loaded facts (pure — testable). */
export function buildStalenessReport(input: {
  templateId: string;
  maxCostCents: number;
  totalCostCents: number;
  deadlineAt: string;
  goalTargetValue: number;
  graphNewestAsOf: Date | null;
  now?: Date;
}): MissionStalenessReport {
  const now = input.now ?? new Date();
  const checks: StalenessCheckResult[] = [];

  checks.push({
    name: "cost_budget",
    ok: input.totalCostCents < input.maxCostCents,
    detail: `spent ${input.totalCostCents}¢ of ${input.maxCostCents}¢ budget`,
  });

  if (!input.graphNewestAsOf) {
    checks.push({
      name: "data_freshness",
      ok: true,
      detail: "no graph data synced yet — nothing to go stale",
    });
  } else {
    const ageDays = (now.getTime() - input.graphNewestAsOf.getTime()) / 86_400_000;
    checks.push({
      name: "data_freshness",
      ok: ageDays <= STALE_DATA_TOLERANCE_DAYS,
      detail: `graph newest as_of ${input.graphNewestAsOf.toISOString()} (${ageDays.toFixed(1)}d old; tolerance ${STALE_DATA_TOLERANCE_DAYS}d)`,
    });
  }

  let templateOk = true;
  try {
    getTemplate(input.templateId);
  } catch {
    templateOk = false;
  }
  const deadlineMs = new Date(input.deadlineAt).getTime();
  const withinDeadline =
    Number.isFinite(deadlineMs) &&
    now.getTime() <= deadlineMs + RESUME_DEADLINE_GRACE_DAYS * 86_400_000;
  const goalSane = input.goalTargetValue > 0;
  checks.push({
    name: "goal_assumptions",
    ok: withinDeadline && goalSane && templateOk,
    detail: `deadline ${input.deadlineAt} (grace ${RESUME_DEADLINE_GRACE_DAYS}d): ${withinDeadline ? "ok" : "EXCEEDED"}; goal target sane: ${goalSane}; template present: ${templateOk}`,
  });

  return {
    fresh: checks.every((c) => c.ok),
    checkedAt: now.toISOString(),
    checks,
    note: "M4 resume re-verification: budgets, data freshness, goal assumptions.",
  };
}

export const TERMINATION_REASON_LABELS: Record<TerminationReason, string> = {
  goal_met: "Goal met",
  step_limit: "Step limit reached",
  cost_budget: "Cost budget exhausted",
  timeout: "Deadline passed",
  consecutive_failures: "Too many consecutive failures",
};

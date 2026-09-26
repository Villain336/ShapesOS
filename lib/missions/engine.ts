// Marketr — Phase 9 M4: durable mission execution engine (SPEC-PHASE9.md §P9C).
//
// Durable state: mission state is persisted to the store before every human
// wait; loadMission rehydrates fully (mission + events + approvals + derived
// progress/termination). Hybrid checkpoints, structured events, explicit
// termination evaluated in code, resume with staleness re-verification
// (wires into M1's killswitch.resumeMission via createStalenessVerifier).
//
// Every mutating path checks isWorkspaceFrozen / isMissionPaused FIRST
// (injected, mirroring the M1 executor dep pattern). PURE of prisma and
// @/ imports — safe for tsx-run tests.

import { getTemplate } from "./templates";
import {
  buildStalenessReport,
  checkTermination,
  isCountedStep,
  missionProgress,
  validateGoal,
  type CheckpointReason,
  type CheckpointRecord,
  type CheckpointSnapshot,
  type MissionStalenessReport,
  type TerminationConfig,
  type TerminationReason,
} from "./types";
import type {
  AppendEventInput,
  MissionStore,
  StoredMission,
  StoredMissionApproval,
  StoredMissionEvent,
} from "./store";

export class MissionError extends Error {
  /** HTTP-ish status for the API layer to map (404 not found, 400 bad input, 422 safety halt). */
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "MissionError";
    this.status = status;
  }
}

export interface EngineDeps {
  store: MissionStore;
  /** Kill-switch check #1: workspace freeze. Checked FIRST on every mutation. */
  isWorkspaceFrozen: (workspaceId: string) => Promise<boolean> | boolean;
  /** Kill-switch check #2: mission pause. Checked FIRST on every mutation. */
  isMissionPaused: (missionId: string, workspaceId: string) => Promise<boolean> | boolean;
  now?: () => Date;
}

async function assertRunnable(deps: EngineDeps, missionId: string, workspaceId: string): Promise<void> {
  if (await deps.isWorkspaceFrozen(workspaceId)) {
    throw new MissionError("Workspace is frozen — mission mutation HALTED. Unfreeze the workspace first.");
  }
  if (await deps.isMissionPaused(missionId, workspaceId)) {
    throw new MissionError("Mission is paused — resume it before mutating (checkpoint/step/decision).");
  }
}

async function assertNotFrozen(deps: EngineDeps, workspaceId: string): Promise<void> {
  if (await deps.isWorkspaceFrozen(workspaceId)) {
    throw new MissionError("Workspace is frozen — mission mutation HALTED. Unfreeze the workspace first.");
  }
}

// ---------------------------------------------------------------------------
// loadMission — full rehydration
// ---------------------------------------------------------------------------

export interface LoadedMission {
  mission: StoredMission;
  events: StoredMissionEvent[];
  approvals: StoredMissionApproval[];
  stepCount: number;
  totalCostCents: number;
  consecutiveFailures: number;
  progress: number;
  termination: { done: boolean; reason: TerminationReason | null };
  nextCheckpoint: string | null;
  planStepCount: number;
}

export async function loadMission(
  deps: EngineDeps,
  missionId: string,
  workspaceId: string,
): Promise<LoadedMission> {
  const mission = await deps.store.getMission(missionId, workspaceId);
  if (!mission) throw new MissionError("Mission not found in workspace.", 404);
  const events = await deps.store.listEvents(missionId, workspaceId);
  const approvals = await deps.store.listApprovals(missionId, workspaceId);

  let stepCount = 0;
  let totalCostCents = 0;
  for (const e of events) {
    if (isCountedStep(e.step)) stepCount += 1;
    totalCostCents += e.costCents;
  }
  // Trailing run of failed step events (meta/housekeeping events don't break the run).
  let consecutiveFailures = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!isCountedStep(e.step)) continue;
    const failed = (e.observation as Record<string, unknown> | undefined)?.failure === true;
    if (failed) consecutiveFailures += 1;
    else break;
  }

  const t = mission.termination;
  const goal = t.goal as { metric: string; targetValue: number; direction?: "increase" | "decrease" };
  const currentValue = readGoalCurrentValue(mission, events);
  const termination = checkTermination({
    goal: { ...goal, direction: goal.direction ?? "increase", currentValue },
    maxSteps: t.maxSteps,
    stepCount,
    maxCostCents: t.maxCostCents,
    totalCostCents,
    deadlineAt: t.deadlineAt,
    maxConsecutiveFailures: t.maxConsecutiveFailures,
    consecutiveFailures,
    now: deps.now?.(),
  });

  const planSteps = planStepsOf(mission);
  const progress = missionProgress(planSteps.length, stepCount, mission.status);
  const nextCheckpoint =
    mission.status === "complete"
      ? null
      : (planSteps.find((s) => s.checkpointAfter && s.order > stepCount)?.title ?? null);

  return {
    mission,
    events,
    approvals,
    stepCount,
    totalCostCents,
    consecutiveFailures,
    progress,
    termination,
    nextCheckpoint,
    planStepCount: planSteps.length,
  };
}

/** Latest reported currentValue for the goal metric (from goal.progress observation). */
function readGoalCurrentValue(
  mission: StoredMission,
  events: StoredMissionEvent[],
): number | undefined {
  const metric = (mission.termination.goal as { metric?: string } | undefined)?.metric;
  if (!metric) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const obs = events[i].observation as Record<string, unknown> | undefined;
    const gp = obs?.goalProgress as Record<string, unknown> | undefined;
    if (gp && gp.metric === metric && typeof gp.currentValue === "number" && Number.isFinite(gp.currentValue)) {
      return gp.currentValue;
    }
  }
  return undefined;
}

function planStepsOf(mission: StoredMission): Array<{ order: number; title: string; checkpointAfter: boolean }> {
  const snap = mission.planSnapshot as { steps?: Array<{ order?: number; title?: string; checkpointAfter?: boolean }> };
  const steps = Array.isArray(snap?.steps) ? snap.steps : [];
  return steps.map((s, i) => ({
    order: typeof s.order === "number" ? s.order : i + 1,
    title: typeof s.title === "string" ? s.title : `Step ${i + 1}`,
    checkpointAfter: s.checkpointAfter === true,
  }));
}

// ---------------------------------------------------------------------------
// startMission — Tier 0: drafts plans, executes nothing.
// ---------------------------------------------------------------------------

export interface StartMissionInput {
  workspaceId: string;
  userId: string;
  templateId: string;
  goal: unknown;
  name?: string;
}

export async function startMission(deps: EngineDeps, input: StartMissionInput): Promise<StoredMission> {
  await assertNotFrozen(deps, input.workspaceId);
  let template;
  try {
    template = getTemplate(input.templateId);
  } catch (e) {
    throw new MissionError(e instanceof Error ? e.message : "Unknown template.", 404);
  }
  let goal;
  try {
    goal = validateGoal(input.goal);
  } catch (e) {
    throw new MissionError(e instanceof Error ? e.message : "Invalid goal.", 400);
  }

  const now = deps.now?.() ?? new Date();
  const deadlineAt = new Date(now.getTime() + goal.timeframeDays * 86_400_000).toISOString();
  const plan = template.plan.map((s) => ({ ...s }));
  const termination: TerminationConfig = {
    maxSteps: template.budgetDefaults.maxSteps,
    maxCostCents: template.budgetDefaults.maxCostCents,
    deadlineAt,
    maxConsecutiveFailures: template.budgetDefaults.maxConsecutiveFailures,
    goal: { metric: goal.metric, targetValue: goal.targetValue, direction: goal.direction },
  };
  const goalJson: Record<string, unknown> = {
    metric: goal.metric,
    targetValue: goal.targetValue,
    unit: goal.unit,
    timeframeDays: goal.timeframeDays,
    direction: goal.direction,
    baseline: goal.baseline,
    label: input.name?.trim() || template.name,
  };

  const mission = await deps.store.createMission({
    workspaceId: input.workspaceId,
    template: template.id,
    goal: goalJson,
    status: "planned",
    planSnapshot: { templateId: template.id, steps: plan },
    checkpoints: [],
    budgetCaps: { maxCostCents: template.budgetDefaults.maxCostCents },
    termination,
    createdBy: input.userId,
  });

  // Genesis event FIRST (durable before any human wait), then planned -> active.
  await deps.store.appendEvent(mission.id, input.workspaceId, {
    actor: "mission-engine",
    step: "mission.genesis",
    observation: {
      templateId: template.id,
      goal: goalJson,
      note: "Tier 0: starting a mission drafts plans and executes nothing.",
    },
  });
  await deps.store.updateMission(mission.id, input.workspaceId, { status: "active" });
  await deps.store.appendEvent(mission.id, input.workspaceId, {
    actor: "mission-engine",
    step: "mission.activated",
    observation: { planSteps: plan.length, deadlineAt },
  });

  const reloaded = await deps.store.getMission(mission.id, input.workspaceId);
  if (!reloaded) throw new MissionError("Mission not found in workspace.", 404);
  return reloaded;
}

// ---------------------------------------------------------------------------
// checkpoint — hybrid checkpointing; evaluates termination afterwards.
// ---------------------------------------------------------------------------

export interface CheckpointResult {
  mission: StoredMission;
  checkpoint: CheckpointRecord;
  termination: { done: boolean; reason: TerminationReason | null };
}

export async function checkpoint(
  deps: EngineDeps,
  missionId: string,
  workspaceId: string,
  reason: CheckpointReason,
  actor = "mission-engine",
): Promise<CheckpointResult> {
  await assertRunnable(deps, missionId, workspaceId);
  const loaded = await loadMission(deps, missionId, workspaceId);
  const now = deps.now?.() ?? new Date();

  const snapshot: CheckpointSnapshot = {
    at: now.toISOString(),
    status: loaded.mission.status,
    stepCount: loaded.stepCount,
    totalCostCents: loaded.totalCostCents,
    pendingApprovals: loaded.approvals.filter((a) => a.status === "pending").length,
    consecutiveFailures: loaded.consecutiveFailures,
  };
  const record: CheckpointRecord = { reason, at: snapshot.at, snapshot };
  await deps.store.updateMission(missionId, workspaceId, {
    checkpoints: [...loaded.mission.checkpoints, record],
  });
  await deps.store.appendEvent(missionId, workspaceId, {
    actor,
    step: "checkpoint",
    observation: { reason, snapshot },
  });

  const termination = await applyTerminationIfDone(deps, missionId, workspaceId, loaded);
  const mission = (await deps.store.getMission(missionId, workspaceId))!;
  return { mission, checkpoint: record, termination };
}

// ---------------------------------------------------------------------------
// appendStepEvent — structured per-step event; evaluates termination.
// ---------------------------------------------------------------------------

export async function appendStepEvent(
  deps: EngineDeps,
  missionId: string,
  workspaceId: string,
  input: AppendEventInput,
): Promise<StoredMissionEvent> {
  await assertRunnable(deps, missionId, workspaceId);
  const ev = await deps.store.appendEvent(missionId, workspaceId, input);
  const loaded = await loadMission(deps, missionId, workspaceId);
  await applyTerminationIfDone(deps, missionId, workspaceId, loaded);
  return ev;
}

/** Evaluate termination; when done, flip to complete + append the terminal event. */
async function applyTerminationIfDone(
  deps: EngineDeps,
  missionId: string,
  workspaceId: string,
  loaded: LoadedMission,
): Promise<{ done: boolean; reason: TerminationReason | null }> {
  const { done, reason } = loaded.termination;
  if (!done || !reason) return { done: false, reason: null };
  if (loaded.mission.status === "complete") return { done: true, reason };
  await deps.store.updateMission(missionId, workspaceId, { status: "complete" });
  await deps.store.appendEvent(missionId, workspaceId, {
    actor: "mission-engine",
    step: "mission.terminated",
    observation: {
      reason,
      goal: loaded.mission.termination.goal,
      stepCount: loaded.stepCount,
      totalCostCents: loaded.totalCostCents,
    },
  });
  return { done: true, reason };
}

// ---------------------------------------------------------------------------
// decideApproval — the decide-API contract (M6's approval inbox calls this).
// ---------------------------------------------------------------------------

export type ApprovalDecision = "approved" | "denied";

export interface DecideApprovalInput {
  missionId: string;
  approvalId: string;
  workspaceId: string;
  decision: ApprovalDecision;
  decidedBy: string;
}

export async function decideApproval(
  deps: EngineDeps,
  input: DecideApprovalInput,
): Promise<StoredMissionApproval> {
  const { missionId, approvalId, workspaceId, decision, decidedBy } = input;
  if (decision !== "approved" && decision !== "denied") {
    throw new MissionError('decision must be "approved" or "denied".', 400);
  }
  // Kill switches FIRST: frozen always halts; paused missions take no decisions
  // until resumed (resume re-verifies staleness before anything moves).
  await assertRunnable(deps, missionId, workspaceId);

  const approval = await deps.store.getApproval(approvalId, workspaceId);
  if (!approval || (approval.missionId !== null && approval.missionId !== missionId)) {
    throw new MissionError("Approval not found in workspace.", 404);
  }
  if (approval.status !== "pending") {
    throw new MissionError(
      `Cannot decide approval in status "${approval.status}" — only pending approvals can be decided.`,
    );
  }
  const now = deps.now?.() ?? new Date();
  if (approval.expiresAt && approval.expiresAt.getTime() <= now.getTime()) {
    await deps.store.markApprovalExpired(approvalId, workspaceId);
    throw new MissionError("Approval expired — re-request approval.");
  }

  const decided = await deps.store.decideApproval(approvalId, workspaceId, decision, decidedBy, now);
  await deps.store.appendEvent(missionId, workspaceId, {
    actor: decidedBy,
    step: "approval.decided",
    observation: {
      approvalId,
      decision,
      action: approval.action,
      tier: approval.tier,
      bindingHash: approval.bindingHash,
    },
  });
  return decided;
}

// ---------------------------------------------------------------------------
// pauseMission / resumeMission — per-mission kill switch (SPEC §3.5, §P9C).
//
// NOTE: M1's killswitch.ts ships pauseMission/resumeMission with the same
// semantics, but those query via the global prisma client WITHOUT pinning
// the tenant GUC — against the live DB (FORCE RLS on missions/*) they see
// zero rows and always throw "Mission not found". lib/orchestrator/** is
// read-only for M4, so the API routes use THESE store-backed twins instead:
// same status transitions, same timeline step names ("killswitch.pause" /
// "killswitch.resume" / "killswitch.resume_blocked"), GUC-scoped through the
// injected store. The verifier shape stays plug-compatible with
// killswitch.resumeMission's verifyStaleness hook for when M1's GUC handling
// is fixed.
// ---------------------------------------------------------------------------

/**
 * pauseMission — status -> paused. Idempotent: already-paused is a no-op.
 * Kill-switch check: a frozen workspace halts even pausing.
 */
export async function pauseMission(
  deps: EngineDeps,
  missionId: string,
  workspaceId: string,
  actor = "mission-engine",
): Promise<StoredMission> {
  await assertNotFrozen(deps, workspaceId);
  const mission = await deps.store.getMission(missionId, workspaceId);
  if (!mission) throw new MissionError("Mission not found in workspace.", 404);
  if (mission.status === "paused") return mission;
  if (mission.status === "complete" || mission.status === "archived") {
    throw new MissionError(`Cannot pause mission in status "${mission.status}".`);
  }
  const updated = await deps.store.updateMission(missionId, workspaceId, { status: "paused" });
  await deps.store.appendEvent(missionId, workspaceId, {
    actor,
    step: "killswitch.pause",
    observation: { from: mission.status, to: "paused" },
  });
  return updated;
}

export interface ResumeMissionResult {
  mission: StoredMission;
  report: MissionStalenessReport;
}

/**
 * resumeMission — paused -> active, but ONLY after staleness re-verification
 * (SPEC §P9C): budgets, graph data freshness, goal assumptions. Stale beyond
 * tolerance -> stays paused; the verifier appends the human-review event.
 */
export async function resumeMission(
  deps: EngineDeps,
  missionId: string,
  workspaceId: string,
  opts: {
    actor?: string;
    verifyStaleness?: (missionId: string, workspaceId: string) => Promise<MissionStalenessReport>;
  } = {},
): Promise<ResumeMissionResult> {
  await assertNotFrozen(deps, workspaceId);
  const mission = await deps.store.getMission(missionId, workspaceId);
  if (!mission) throw new MissionError("Mission not found in workspace.", 404);
  if (mission.status !== "paused") {
    throw new MissionError(
      `Cannot resume mission in status "${mission.status}" — only paused missions resume.`,
    );
  }
  const verify =
    opts.verifyStaleness ??
    (async (): Promise<MissionStalenessReport> => ({
      fresh: false,
      checkedAt: (deps.now?.() ?? new Date()).toISOString(),
      checks: [
        {
          name: "verifier_supplied",
          ok: false,
          detail: "No staleness verifier supplied — refusing to assume freshness. Wire createStalenessVerifier.",
        },
      ],
      note: "Fail-closed: resume requires a real verifier.",
    }));
  const report = await verify(missionId, workspaceId);
  if (!report.fresh) {
    // The verifier appends the human-review (resume_blocked) event; ensure
    // one exists even for custom verifiers that don't.
    const events = await deps.store.listEvents(missionId, workspaceId, 5);
    if (!events.some((e) => e.step === "killswitch.resume_blocked")) {
      await deps.store.appendEvent(missionId, workspaceId, {
        actor: opts.actor ?? "mission-engine",
        step: "killswitch.resume_blocked",
        observation: { reason: "stale_beyond_tolerance", report, action: "human review required before resume" },
      });
    }
    throw new MissionError(
      `Staleness re-verification FAILED — mission stays paused. Failed checks: ${report.checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(", ")}`,
    );
  }
  const updated = await deps.store.updateMission(missionId, workspaceId, { status: "active" });
  await deps.store.appendEvent(missionId, workspaceId, {
    actor: opts.actor ?? "mission-engine",
    step: "killswitch.resume",
    observation: { stalenessReport: report },
  });
  return { mission: updated, report };
}

// ---------------------------------------------------------------------------
// Staleness re-verification — wires into M1's killswitch.resumeMission hook.
// ---------------------------------------------------------------------------

export interface StalenessVerifierDeps {
  store: MissionStore;
  /** Graph recency probe (Prisma twin in API layer; injected stub in tests). */
  getGraphNewestAsOf?: (workspaceId: string) => Promise<Date | null>;
  now?: () => Date;
}

/**
 * createStalenessVerifier — returns the verifyStaleness fn for
 * killswitch.resumeMission. Re-verifies budgets, data freshness (graph
 * as_of recency), and goal assumptions; appends a re-verification event on
 * failure (the human-review event). Stale beyond tolerance -> stays paused.
 */
export function createStalenessVerifier(verifierDeps: StalenessVerifierDeps) {
  return async function verifyStaleness(
    missionId: string,
    workspaceId: string,
  ): Promise<MissionStalenessReport> {
    const now = verifierDeps.now?.() ?? new Date();
    const mission = await verifierDeps.store.getMission(missionId, workspaceId);
    if (!mission) {
      return {
        fresh: false,
        checkedAt: now.toISOString(),
        checks: [{ name: "mission_exists", ok: false, detail: "mission not found in workspace" }],
        note: "Re-verification could not load the mission.",
      };
    }
    const events = await verifierDeps.store.listEvents(missionId, workspaceId);
    const totalCostCents = events.reduce((sum, e) => sum + e.costCents, 0);
    const graphNewestAsOf = (await verifierDeps.getGraphNewestAsOf?.(workspaceId)) ?? null;

    const report = buildStalenessReport({
      templateId: mission.template,
      maxCostCents: mission.termination.maxCostCents,
      totalCostCents,
      deadlineAt: mission.termination.deadlineAt,
      goalTargetValue: mission.termination.goal.targetValue,
      graphNewestAsOf,
      now,
    });

    if (!report.fresh) {
      // Human-review event: stays paused; the resume path throws after this.
      await verifierDeps.store.appendEvent(missionId, workspaceId, {
        actor: "mission-engine",
        step: "killswitch.resume_blocked",
        observation: {
          reason: "stale_beyond_tolerance",
          report,
          action: "human review required before resume",
        },
      });
    }
    return report;
  };
}

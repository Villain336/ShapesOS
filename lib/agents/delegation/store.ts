// ShapesOS — Phase 16: automatic delegation, the database half.
//
// A delegating run (the lead, or a sub-agent with the opt-in `delegate`
// group) keeps its plans on its own AgentRun row: agentState.delegation =
// { v, plans: [{ planId, tasks: [{ …, status }] }], continuation }. Every
// change to that state happens in ONE place, settleDelegation(), inside a
// transaction that holds the parent row lock (SELECT … FOR UPDATE), so
// siblings finishing at the same moment are serialised:
//
//   * a child's outcome lands on its task (succeeded / failed / cancelled /
//     awaiting_confirmation with its proposals);
//   * tasks whose prerequisite failed are skipped; tasks whose prerequisites
//     all succeeded start — a child AgentRun (parentRunId) and a
//     `subagent_run` agent job, inserted in the same transaction — within the
//     per-run cap and the per-workspace cap (the workspace count runs under a
//     transaction-scoped advisory lock, so two parents can't both take the
//     last slot);
//   * when nothing is running and some children wait for the user's OK, ONE
//     assistant message lists every waiting proposal and the parent run
//     becomes `awaiting_confirmation`;
//   * when every task is finished, the join: plan.joinedAt is set and the
//     parent's continuation job (`delegation_join`) inserted in the same
//     transaction — exactly once, whoever settles last, however many workers
//     race, because the row lock serialises them and the flag commits with
//     the job.
//
// Tables touched are FORCE RLS: everything runs under withWorkspaceScope.

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { agentWorkerConfig } from "@/lib/agents/queue/config";
import type { ChatToolCall } from "@/lib/chat/tool-exec";
import {
  delegationProgress,
  doomedTasks,
  effectiveDelegationLimits,
  LIVE_TASK_STATUSES,
  progressLine,
  tasksToStart,
  TERMINAL_TASK_STATUSES,
  type DelegationLimits,
  type DelegationPlanState,
  type DelegationTaskState,
  type DelegationTaskStatus,
  type Deliverable,
} from "./plan";

type Tx = Prisma.TransactionClient;

// ── settings ────────────────────────────────────────────────────────────────

export interface DelegationSettings {
  /** "Automatic delegation": the lead is offered delegate_tasks (default on). */
  autoDelegation: boolean;
  limits: DelegationLimits;
  /** Which values the workspace set (null = the code default). */
  stored: Partial<Record<keyof DelegationLimits, number | null>>;
}

export async function loadDelegationSettings(workspaceId: string): Promise<DelegationSettings> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentDelegationSetting.findFirst({ where: { workspaceId } }),
  ).catch(() => null);
  const stored = {
    maxParallelPerRun: row?.maxParallelPerRun ?? null,
    maxLivePerWorkspace: row?.maxLivePerWorkspace ?? null,
    maxWidth: row?.maxWidth ?? null,
    maxDepth: row?.maxDepth ?? null,
  };
  return { autoDelegation: row?.autoDelegation ?? true, limits: effectiveDelegationLimits(stored), stored };
}

// ── state shapes ────────────────────────────────────────────────────────────

/** A `subagent_run` job: start or resume one delegated child. */
export interface SubagentRunJobPayload {
  workspaceId: string;
  childRunId: string;
  parentRunId: string;
  planId: string;
  taskId: string;
  projectId: string;
  userId: string;
  role: string;
  threadId: string | null;
}

/** How the delegating run carries on after the join. */
export type DelegationContinuation =
  | { kind: "chat_turn"; payload: Omit<import("@/lib/chat/agent").ChatTurnJobPayload, "runId"> }
  | { kind: "subagent_run"; payload: Omit<SubagentRunJobPayload, "childRunId"> };

export interface DelegationState {
  v: 1;
  plans: DelegationPlanState[];
  continuation: DelegationContinuation;
}

/** What a delegated child carries in its own agentState. */
export interface DelegatedBy {
  parentRunId: string;
  planId: string;
  taskId: string;
  depth: number;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readDelegation(agentState: unknown): DelegationState | null {
  const d = rec(agentState).delegation as DelegationState | undefined;
  return d && d.v === 1 && Array.isArray(d.plans) ? d : null;
}

export function readDelegatedBy(agentState: unknown): DelegatedBy | null {
  const d = rec(agentState).delegatedBy as DelegatedBy | undefined;
  return d && typeof d.parentRunId === "string" && typeof d.planId === "string" && typeof d.taskId === "string" ? d : null;
}

/** A plan the parent still waits on (not joined yet). */
export function hasOpenPlan(state: DelegationState | null): boolean {
  return !!state?.plans.some((p) => !p.joinedAt);
}

export function planIdFor(runId: string, toolUseId: string): string {
  return `plan_${createHash("sha256").update(`${runId}:${toolUseId}`).digest("hex").slice(0, 12)}`;
}

// ── low-level helpers (inside the locked transaction) ───────────────────────

interface LockedRun {
  id: string;
  status: string;
  agentState: Record<string, unknown>;
  cancelRequestedAt: Date | null;
  threadId: string | null;
  startedBy: string;
  agentKey: string | null;
}

async function lockRun(tx: Tx, workspaceId: string, runId: string): Promise<LockedRun | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "agent_runs" WHERE "id" = ${runId} AND "workspace_id" = ${workspaceId} FOR UPDATE`;
  if (rows.length === 0) return null;
  const run = await tx.agentRun.findFirst({
    where: { id: runId, workspaceId },
    select: { id: true, status: true, agentState: true, cancelRequestedAt: true, threadId: true, startedBy: true, agentKey: true },
  });
  return run ? { ...run, status: String(run.status), agentState: rec(run.agentState) } : null;
}

async function writeState(tx: Tx, workspaceId: string, run: LockedRun, state: DelegationState): Promise<void> {
  await tx.agentRun.update({
    where: { id: run.id, workspaceId },
    data: { agentState: { ...run.agentState, delegation: state } as unknown as Prisma.InputJsonValue },
  });
}

async function insertJob(tx: Tx, input: { workspaceId: string; kind: string; runId: string; payload: unknown; runAfter?: Date }): Promise<string> {
  const job = await tx.agentJob.create({
    data: {
      workspaceId: input.workspaceId,
      kind: input.kind,
      runId: input.runId,
      payload: input.payload as Prisma.InputJsonValue,
      maxAttempts: agentWorkerConfig().maxAttempts,
      ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    },
    select: { id: true },
  });
  return job.id;
}

/** Delegated chat sub-agents queued or running in the workspace (the workspace cap). */
async function liveDelegatedInWorkspace(tx: Tx, workspaceId: string): Promise<number> {
  return tx.agentRun.count({
    where: { workspaceId, kind: "chat", parentRunId: { not: null }, status: { in: ["queued", "running"] } },
  });
}

// ── effects to run after the transaction commits ───────────────────────────

export interface SettleEffects {
  /** Timeline notes for the parent run. */
  notes: Array<{ runId: string; summary: string; payload?: Record<string, unknown> }>;
  /** Jobs inserted (the caller may kick a local worker). */
  jobs: number;
  /** The parent run must be finished cancelled (it was stopped and nothing is left). */
  finishParentCancelled: boolean;
  joined: boolean;
  postedApprovals: boolean;
}

function noEffects(): SettleEffects {
  return { notes: [], jobs: 0, finishParentCancelled: false, joined: false, postedApprovals: false };
}

/** A child's outcome, or a decision about it, landing on its task. */
export interface TaskUpdate {
  planId: string;
  taskId: string;
  status: DelegationTaskStatus;
  deliverable?: Deliverable;
  error?: string;
  costMicroUsd?: number;
  steps?: number;
  activeMs?: number;
  proposals?: ChatToolCall[];
  /** Resume the child (after the user decided on its proposals): re-queue its job. */
  resume?: boolean;
}

const RUN_AFTER_TICK_MS = 5_000;

function agentLabel(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function approvalsText(proposals: ChatToolCall[], who: (c: ChatToolCall) => string, describe: (c: ChatToolCall) => string): string {
  const agents = new Set(proposals.map(who));
  return [
    `${agents.size} sub-agent${agents.size === 1 ? "" : "s"} need${agents.size === 1 ? "s" : ""} your OK before carrying on:`,
    "",
    ...proposals.map((c, i) => `${i + 1}. ${describe(c)}`),
    "",
    proposals.length === 1
      ? "Reply **yes** to approve it, or send a new message to decline."
      : `Reply **yes** to approve all ${proposals.length}, or send a new message to decline them.`,
  ].join("\n");
}

/**
 * The single state transition for a delegating run (see the header). Pass
 * `update` when a child settled or the user decided on its proposals; pass
 * nothing to re-check (arming, a workspace slot freed up, a stop).
 */
export async function settleDelegation(
  workspaceId: string,
  parentRunId: string,
  update?: TaskUpdate,
  opts: { arm?: boolean } = {},
): Promise<SettleEffects> {
  const { proposalText } = await import("@/lib/chat/tool-exec");
  const { agentDisplayName, isAgentKey } = await import("@/lib/agents/grants");
  const effects = noEffects();
  const now = new Date();
  await withWorkspaceScope(
    workspaceId,
    async (tx) => {
      const parent = await lockRun(tx as Tx, workspaceId, parentRunId);
      if (!parent) return;
      const state = readDelegation(parent.agentState);
      if (!state) return;
      const t = tx as Tx;

      // 1. The update.
      if (update) {
        const plan = state.plans.find((p) => p.planId === update.planId);
        const task = plan?.tasks.find((x) => x.id === update.taskId);
        if (plan && task && !TERMINAL_TASK_STATUSES.has(task.status)) {
          task.status = update.status;
          if (update.deliverable) task.deliverable = update.deliverable;
          if (update.error !== undefined) task.error = update.error;
          if (update.costMicroUsd !== undefined) task.costMicroUsd = update.costMicroUsd;
          if (update.steps !== undefined) task.steps = update.steps;
          if (update.activeMs !== undefined) task.activeMs = update.activeMs;
          if (update.status === "awaiting_confirmation") task.proposals = update.proposals ?? [];
          else delete task.proposals;
          if (TERMINAL_TASK_STATUSES.has(update.status)) task.endedAt = now.toISOString();
          if (update.resume && task.childRunId) {
            task.status = "queued";
            await t.agentRun.update({ where: { id: task.childRunId, workspaceId }, data: { status: "running" } });
            await insertJob(t, {
              workspaceId,
              kind: "subagent_run",
              runId: task.childRunId,
              payload: childPayload(state, plan, task, parent),
            });
            effects.jobs++;
            plan.approvalsPostedKey = undefined;
          }
          effects.notes.push({
            runId: parentRunId,
            summary: `${agentLabel(task.agent)} (${task.id}): ${update.resume ? "approved, carrying on" : update.status.replace(/_/g, " ")}`,
            payload: { kind: "delegation_task", planId: plan.planId, taskId: task.id, status: task.status },
          });
        }
      }

      // 2. Child runs are the truth for stops that happened elsewhere.
      const childIds = state.plans.flatMap((p) => p.tasks.map((x) => x.childRunId).filter((x): x is string => !!x));
      if (childIds.length) {
        const rows = await t.agentRun.findMany({ where: { workspaceId, id: { in: childIds } }, select: { id: true, status: true } });
        const status = new Map(rows.map((r) => [r.id, String(r.status)]));
        for (const p of state.plans) {
          for (const x of p.tasks) {
            if (!x.childRunId || TERMINAL_TASK_STATUSES.has(x.status)) continue;
            const s = status.get(x.childRunId);
            if (s === "cancelled") {
              x.status = "cancelled";
              x.error ??= "Stopped before it finished.";
              x.endedAt = now.toISOString();
              delete x.proposals;
            } else if (s === "failed" && x.status !== "awaiting_confirmation") {
              x.status = "failed";
              x.error ??= "The sub-agent's run failed.";
              x.endedAt = now.toISOString();
            }
          }
        }
      }

      const stopped = parent.cancelRequestedAt !== null || ["cancelled", "failed", "succeeded"].includes(parent.status);
      const settings = await t.agentDelegationSetting.findFirst({ where: { workspaceId } }).catch(() => null);
      const limits = effectiveDelegationLimits(settings);

      for (const plan of state.plans) {
        if (plan.joinedAt) continue;
        if (opts.arm) plan.armed = true;

        if (stopped) {
          // The delegating run was stopped: nothing new starts.
          for (const x of plan.tasks) {
            if (x.status === "pending") {
              x.status = "cancelled";
              x.error = "Not started: the task was stopped.";
              x.endedAt = now.toISOString();
            }
          }
          continue;
        }

        // 3. Tasks that can never start.
        for (const { task, because } of doomedTasks(plan.tasks)) {
          task.status = "skipped";
          task.error = `Not started: it needed "${because}", which did not succeed.`;
          task.endedAt = now.toISOString();
        }

        // 4. Start what may start (only once the parent saved its waiting state).
        if (plan.armed) {
          const liveForRun = state.plans.reduce((n, p) => n + p.tasks.filter((x) => LIVE_TASK_STATUSES.has(x.status)).length, 0);
          await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shapes-delegation:${workspaceId}`}))`;
          const liveForWorkspace = await liveDelegatedInWorkspace(t, workspaceId);
          const start = tasksToStart(plan.tasks, { liveForRun, liveForWorkspace, limits });
          for (const task of start) {
            const child = await t.agentRun.create({
              data: {
                workspaceId,
                kind: "chat",
                startedBy: parent.startedBy,
                threadId: parent.threadId,
                agentKey: task.agent,
                parentRunId,
                allowedTools: task.grant,
                agentState: {
                  task: task.brief.slice(0, 500),
                  projectId: projectIdOf(state),
                  delegatedBy: { parentRunId, planId: plan.planId, taskId: task.id, depth: plan.depth } satisfies DelegatedBy,
                  budget: task.budget,
                  deliverable: task.deliverableSpec,
                } as unknown as Prisma.InputJsonValue,
              },
              select: { id: true },
            });
            task.childRunId = child.id;
            task.status = "queued";
            task.startedAt = now.toISOString();
            await insertJob(t, { workspaceId, kind: "subagent_run", runId: child.id, payload: childPayload(state, plan, task, parent) });
            effects.jobs++;
            effects.notes.push({
              runId: parentRunId,
              summary: `Handed ${task.id} to the ${agentLabel(task.agent)}: ${task.brief.slice(0, 160)}`,
              payload: { kind: "delegation_task", planId: plan.planId, taskId: task.id, status: "queued", childRunId: child.id, agent: task.agent },
            });
          }
          // Ready work held back only by the caps: look again shortly.
          const stillReady = plan.tasks.some((x) => x.status === "pending") && start.length === 0;
          const anyLive = plan.tasks.some((x) => LIVE_TASK_STATUSES.has(x.status));
          if (stillReady && !anyLive) {
            await insertJob(t, {
              workspaceId,
              kind: "delegation_tick",
              runId: parentRunId,
              payload: { workspaceId, parentRunId },
              runAfter: new Date(now.getTime() + RUN_AFTER_TICK_MS),
            });
            effects.jobs++;
          }
        }

        const live = plan.tasks.some((x) => LIVE_TASK_STATUSES.has(x.status));
        const pendingReady = plan.tasks.some((x) => x.status === "pending");
        const waiting = plan.tasks.filter((x) => x.status === "awaiting_confirmation");

        // 5. Everyone still running is done and some wait for the user: one message, all proposals.
        if (!live && waiting.length > 0) {
          const proposals = waiting.flatMap((x) => (x.proposals ?? []) as ChatToolCall[]);
          const key = proposals.map((c) => `${c.runId}:${c.toolUseId}`).sort().join("|");
          if (proposals.length && plan.approvalsPostedKey !== key && parent.threadId) {
            plan.approvalsPostedKey = key;
            const who = (c: ChatToolCall) => (c.agentKey && isAgentKey(c.agentKey) ? agentDisplayName(c.agentKey) : "Sub-agent");
            const text = approvalsText(proposals, who, (c) => proposalText(c).split("\n").slice(0, 2).join(" ").replace(/\s+Reply \*\*yes\*\*.*$/, "").trim());
            await t.aiChatMessage.create({
              data: { threadId: parent.threadId, role: "assistant", content: text, toolCalls: proposals as unknown as Prisma.InputJsonValue },
            });
            await t.aiChatThread.update({ where: { id: parent.threadId }, data: { updatedAt: now } }).catch(() => undefined);
            await t.agentRun.update({ where: { id: parentRunId, workspaceId }, data: { status: "awaiting_confirmation" } });
            effects.postedApprovals = true;
            effects.notes.push({
              runId: parentRunId,
              summary: `Waiting for your OK on ${proposals.length} sub-agent action${proposals.length === 1 ? "" : "s"}`,
              payload: { kind: "delegation_approvals", planId: plan.planId, count: proposals.length },
            });
          }
          continue;
        }
        if (live || pendingReady) {
          if (parent.status === "awaiting_confirmation") await t.agentRun.update({ where: { id: parentRunId, workspaceId }, data: { status: "running" } });
          continue;
        }

        // 6. Every task finished: the join, exactly once.
        if (plan.tasks.every((x) => TERMINAL_TASK_STATUSES.has(x.status))) {
          plan.joinedAt = now.toISOString();
          const p = delegationProgress(plan.tasks);
          const cont = state.continuation;
          plan.joinJobId = await insertJob(t, {
            workspaceId,
            kind: "delegation_join",
            runId: parentRunId,
            payload:
              cont.kind === "chat_turn"
                ? { kind: "chat_turn", planId: plan.planId, turn: { ...cont.payload, runId: parentRunId } }
                : { kind: "subagent_run", planId: plan.planId, run: { ...cont.payload, childRunId: parentRunId } },
          });
          if (parent.status === "awaiting_confirmation") await t.agentRun.update({ where: { id: parentRunId, workspaceId }, data: { status: "running" } });
          effects.jobs++;
          effects.joined = true;
          effects.notes.push({
            runId: parentRunId,
            summary: `All sub-agents finished (${progressLine(p)}; ${p.succeeded} succeeded): checking and merging`,
            payload: { kind: "delegation_join", planId: plan.planId, ...p },
          });
        }
      }

      // A stopped parent with nothing left running ends cancelled (it waits on nobody).
      if (stopped && parent.status !== "cancelled" && !["succeeded", "failed"].includes(parent.status)) {
        const anyLive = state.plans.some((p) => p.tasks.some((x) => LIVE_TASK_STATUSES.has(x.status)));
        if (!anyLive && hasOpenPlan(state)) effects.finishParentCancelled = true;
      }
      await writeState(t, workspaceId, parent, state);
    },
    { timeoutMs: 20_000 },
  );
  await applyEffects(workspaceId, parentRunId, effects);
  return effects;
}

function projectIdOf(state: DelegationState): string {
  return state.continuation.payload.projectId;
}

function childPayload(state: DelegationState, plan: DelegationPlanState, task: DelegationTaskState, parent: LockedRun): SubagentRunJobPayload {
  const c = state.continuation.payload;
  return {
    workspaceId: c.workspaceId,
    childRunId: task.childRunId!,
    parentRunId: parent.id,
    planId: plan.planId,
    taskId: task.id,
    projectId: c.projectId,
    userId: c.userId,
    role: String(c.role),
    threadId: parent.threadId,
  };
}

async function applyEffects(workspaceId: string, parentRunId: string, effects: SettleEffects): Promise<void> {
  const { appendAgentRunEvent, finishAgentRun } = await import("@/lib/agents/runs/service");
  for (const n of effects.notes) {
    await appendAgentRunEvent(workspaceId, n.runId, { type: "note", summary: n.summary.slice(0, 500), payload: n.payload }).catch(() => undefined);
  }
  if (effects.finishParentCancelled) await finishAgentRun(workspaceId, parentRunId, "cancelled").catch(() => undefined);
  if (effects.jobs > 0) {
    const { kickLocalDelegationWorker } = await import("./local-worker");
    kickLocalDelegationWorker();
  }
}

// ── creating a plan ─────────────────────────────────────────────────────────

/**
 * Record a new plan on the delegating run (idempotent per tool_use id: a
 * resumed run that re-executes delegate_tasks gets the plan it already made).
 * The plan starts UNARMED: children start once the run has saved its waiting
 * state (armDelegation), with a safety-net tick in case that never comes.
 */
export async function recordPlan(input: {
  workspaceId: string;
  runId: string;
  plan: DelegationPlanState;
  continuation: DelegationContinuation;
}): Promise<{ plan: DelegationPlanState; created: boolean }> {
  return withWorkspaceScope(input.workspaceId, async (tx) => {
    const t = tx as Tx;
    const run = await lockRun(t, input.workspaceId, input.runId);
    if (!run) throw new Error("The delegating run is gone.");
    const state: DelegationState = readDelegation(run.agentState) ?? { v: 1, plans: [], continuation: input.continuation };
    const existing = state.plans.find((p) => p.toolUseId === input.plan.toolUseId);
    if (existing) return { plan: existing, created: false };
    if (hasOpenPlan(state)) throw new Error("A delegation plan is already in progress for this run; wait for its results.");
    state.plans.push(input.plan);
    state.continuation = input.continuation;
    await writeState(t, input.workspaceId, run, state);
    await insertJob(t, {
      workspaceId: input.workspaceId,
      kind: "delegation_tick",
      runId: input.runId,
      payload: { workspaceId: input.workspaceId, parentRunId: input.runId, safetyNet: true },
      runAfter: new Date(Date.now() + 30_000),
    });
    return { plan: input.plan, created: true };
  });
}

/** The delegating run saved its waiting state: let its children start. */
export function armDelegation(workspaceId: string, runId: string): Promise<SettleEffects> {
  return settleDelegation(workspaceId, runId, undefined, { arm: true });
}

/** Read a run's delegation state (no lock). */
export async function getDelegation(workspaceId: string, runId: string): Promise<{ state: DelegationState | null; status: string; delegatedBy: DelegatedBy | null } | null> {
  const run = await withWorkspaceScope(workspaceId, (tx) =>
    tx.agentRun.findFirst({ where: { id: runId, workspaceId }, select: { agentState: true, status: true } }),
  );
  if (!run) return null;
  return { state: readDelegation(run.agentState), status: String(run.status), delegatedBy: readDelegatedBy(run.agentState) };
}

/** Did the run delegate a plan whose results are not back yet? */
export async function isWaitingOnChildren(workspaceId: string, runId: string): Promise<boolean> {
  const d = await getDelegation(workspaceId, runId).catch(() => null);
  return hasOpenPlan(d?.state ?? null);
}

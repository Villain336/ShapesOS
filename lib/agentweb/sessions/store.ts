// ShapesOS — Phase 21A round 2 (WS=agentweb): browsing sessions at rest (agentweb_sessions, FORCE RLS).
//
// A session is an AgentRun that used the governed browser; this table adds what a person needs
// to supervise the web part (control, a step awaiting approval, caps, what was touched). The
// run, its children, its timeline and its cost stay in agent_runs / agent_run_events: nothing
// here is a parallel run table, and deleting the run deletes the session row.
// Concurrency uses the Phase 16 delegation limit maxLivePerWorkspace: a workspace cannot have
// more live browsing sessions than it may have live delegated sub-agents.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { loadDelegationSettings } from "@/lib/agents/delegation/store";
import { runUsageTotals } from "@/lib/agents/runs/usage";
import { LIVE_RUN_STATUSES } from "@/lib/agents/runs/types";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { AosStatus } from "@/lib/aos/status";
import { creditsOf, gate, redactArgs, transition, type Action, type Control, type Gate, type NeedsReason, type Pending, type SessionState, type StepMode } from "./control";

type Tx = Prisma.TransactionClient;

export const DEFAULT_MAX_STEPS = 60;
export const DEFAULT_MAX_SECONDS = 1800;
export const DEFAULT_MAX_CREDITS = 150;
export const CAP_BOUNDS = { maxSteps: [1, 500], maxSeconds: [60, 14_400], maxCredits: [1, 5000] } as const;

export class SessionError extends Error {
  constructor(
    readonly code: "not_found" | "bad_state" | "bad_caps" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface SessionView {
  runId: string;
  runKind: string;
  agent: string | null;
  runStatus: string;
  startedBy: string;
  control: Control;
  controlBy: string | null;
  stepMode: StepMode;
  steps: number;
  maxSteps: number;
  startedAt: string;
  lastStepAt: string | null;
  maxSeconds: number;
  costMicroUsd: number;
  credits: number;
  maxCredits: number;
  currentUrl: string | null;
  channel: string | null;
  origins: string[];
  needsReason: NeedsReason | null;
  pending: Pending | null;
  endedReason: string | null;
  live: boolean;
  /** The Agentic OS status shape this session is drawn with. */
  status: AosStatus | null;
}

type Row = {
  runId: string;
  workspaceId: string;
  startedBy: string;
  taskKey: string;
  control: string;
  controlBy: string | null;
  stepMode: string;
  pending: unknown;
  lastNote: string | null;
  maxSteps: number;
  maxSeconds: number;
  maxCredits: number;
  steps: number;
  currentUrl: string | null;
  channel: string | null;
  origins: string[];
  needsReason: string | null;
  endedReason: string | null;
  startedAt: Date;
  lastStepAt: Date | null;
  run?: { status: string; kind: string; agentKey: string | null } | null;
};

/** The shape a session is drawn with: agent states only, and "needs you" whenever a person is wanted. */
export function statusOf(runStatus: string, control: Control, needs: NeedsReason | null): AosStatus | null {
  if (runStatus === "failed") return "failed";
  if (runStatus === "succeeded") return "done";
  if (runStatus === "cancelled") return null;
  if (runStatus === "queued") return "queued";
  if (needs || runStatus === "awaiting_confirmation" || control === "paused") return "needs";
  return "running";
}

const isLive = (runStatus: string) => (LIVE_RUN_STATUSES as readonly string[]).includes(runStatus);

async function costOf(tx: Tx, workspaceId: string, runId: string): Promise<number> {
  const events = await tx.agentRunEvent.findMany({ where: { workspaceId, runId, type: "usage" }, select: { type: true, payload: true } });
  return runUsageTotals(events).costMicroUsd;
}

function viewOf(r: Row, costMicroUsd: number): SessionView {
  const runStatus = r.run?.status ?? "running";
  const control = r.control as Control;
  const needs = (r.needsReason as NeedsReason | null) ?? null;
  return {
    runId: r.runId,
    runKind: r.run?.kind ?? "chat",
    agent: r.run?.agentKey ?? null,
    runStatus,
    startedBy: r.startedBy,
    control,
    controlBy: r.controlBy,
    stepMode: r.stepMode as StepMode,
    steps: r.steps,
    maxSteps: r.maxSteps,
    startedAt: r.startedAt.toISOString(),
    lastStepAt: r.lastStepAt?.toISOString() ?? null,
    maxSeconds: r.maxSeconds,
    costMicroUsd,
    credits: creditsOf(costMicroUsd),
    maxCredits: r.maxCredits,
    currentUrl: r.currentUrl,
    channel: r.channel,
    origins: r.origins,
    needsReason: needs,
    pending: (r.pending as Pending | null) ?? null,
    endedReason: r.endedReason,
    live: isLive(runStatus),
    status: statusOf(runStatus, control, needs),
  };
}

const RUN_SELECT = { status: true, kind: true, agentKey: true } as const;

/** Create the session row for a run on its first browser step. Null when the run cannot be supervised (no such run) or the workspace is at its live-session limit. */
export async function ensureSession(workspaceId: string, input: { runId: string; startedBy: string; taskKey: string }): Promise<{ ok: true; created: boolean } | { ok: false; reason: "no_run" | "limit"; message: string }> {
  const settings = await loadDelegationSettings(workspaceId);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const have = await (tx as Tx).agentwebSession.findUnique({ where: { runId: input.runId, workspaceId }, select: { runId: true } });
    if (have) return { ok: true as const, created: false };
    const run = await (tx as Tx).agentRun.findFirst({ where: { id: input.runId, workspaceId }, select: { id: true } });
    if (!run) return { ok: false as const, reason: "no_run" as const, message: "This run is not recorded, so its browsing cannot be supervised." };
    const live = await (tx as Tx).agentwebSession.count({ where: { workspaceId, endedReason: null, run: { status: { in: [...LIVE_RUN_STATUSES] } } } });
    if (live >= settings.limits.maxLivePerWorkspace) {
      return { ok: false as const, reason: "limit" as const, message: `This workspace already has ${live} live browsing sessions, the most it may run at once (Settings, agents, delegation limits). Wait for one to finish.` };
    }
    await (tx as Tx).agentwebSession.create({ data: { runId: input.runId, workspaceId, startedBy: input.startedBy, taskKey: input.taskKey, maxSteps: DEFAULT_MAX_STEPS, maxSeconds: DEFAULT_MAX_SECONDS, maxCredits: DEFAULT_MAX_CREDITS } });
    return { ok: true as const, created: true };
  });
}

export interface Loaded {
  row: Row;
  state: SessionState;
  costMicroUsd: number;
}

export async function loadSession(workspaceId: string, runId: string): Promise<Loaded | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = (await (tx as Tx).agentwebSession.findUnique({ where: { runId, workspaceId }, include: { run: { select: RUN_SELECT } } })) as Row | null;
    if (!row || row.workspaceId !== workspaceId) return null;
    const costMicroUsd = await costOf(tx as Tx, workspaceId, runId);
    return {
      row,
      costMicroUsd,
      state: { control: row.control as Control, stepMode: row.stepMode as StepMode, steps: row.steps, maxSteps: row.maxSteps, startedAt: row.startedAt.getTime(), maxSeconds: row.maxSeconds, costMicroUsd, maxCredits: row.maxCredits, pending: (row.pending as Pending | null) ?? null, lastNote: row.lastNote },
    };
  });
}

/** The gate for the next step. Persists what a decision implies, except a proposal (see persistProposal). */
export async function evaluate(workspaceId: string, runId: string, tool: string, args: Record<string, unknown>, nowMs: number = Date.now()): Promise<Gate> {
  const loaded = await loadSession(workspaceId, runId);
  if (!loaded) return { allow: true };
  const g = gate(loaded.state, tool, args, nowMs);
  const row = loaded.row;
  const data: Prisma.AgentwebSessionUpdateInput = {};
  if (g.allow) {
    if (row.needsReason && row.needsReason !== "proposal" && row.needsReason !== "blocked_by_site" && row.needsReason !== "teach_check") data.needsReason = null;
  } else if (g.needs && row.needsReason !== g.needs) data.needsReason = g.needs;
  if (!g.allow && g.consumeNote) data.lastNote = null;
  if (Object.keys(data).length) await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebSession.update({ where: { runId, workspaceId }, data }));
  return g;
}

export function proposalSummary(tool: string, args: Record<string, unknown>): string {
  if (tool === "browser_navigate") return `Open ${String(args.url ?? "an address").slice(0, 200)}`;
  if (tool === "browser_click") return `Click ${String(args.ref ?? "a control")}`;
  if (tool === "browser_type") return `Type into ${String(args.ref ?? "a field")}`;
  return tool;
}

export async function persistProposal(workspaceId: string, runId: string, tool: string, args: Record<string, unknown>, now: Date = new Date()): Promise<Pending> {
  const pending: Pending = { id: `prop_${randomBytes(6).toString("hex")}`, tool, args: redactArgs(args), summary: proposalSummary(tool, args), proposedAt: now.toISOString() };
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebSession.update({ where: { runId, workspaceId }, data: { pending: pending as unknown as Prisma.InputJsonValue, needsReason: "proposal" } }));
  return pending;
}

/** One executed step: counts it and records where the session is. */
export async function recordStep(workspaceId: string, runId: string, step: { url?: string; origin?: string | null; channel?: string | null }, now: Date = new Date()): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    const row = await (tx as Tx).agentwebSession.findUnique({ where: { runId, workspaceId }, select: { origins: true } });
    if (!row) return;
    const origins = step.origin && !row.origins.includes(step.origin) ? [...row.origins, step.origin].slice(0, 20) : undefined;
    await (tx as Tx).agentwebSession.update({ where: { runId, workspaceId }, data: { steps: { increment: 1 }, lastStepAt: now, ...(step.url ? { currentUrl: step.url.slice(0, 500) } : {}), ...(step.channel ? { channel: step.channel } : {}), ...(origins ? { origins } : {}) } });
  });
}

export async function setNeeds(workspaceId: string, runId: string, reason: NeedsReason | null): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebSession.updateMany({ where: { runId, workspaceId }, data: { needsReason: reason } }));
}

export async function control(workspaceId: string, runId: string, userId: string, action: Action, now: Date = new Date()): Promise<SessionView> {
  const loaded = await loadSession(workspaceId, runId);
  if (!loaded) throw new SessionError("not_found", "That session was not found.");
  if (!isLive(loaded.row.run?.status ?? "")) throw new SessionError("bad_state", "That session has finished.");
  const t = transition(loaded.row.control as Control, action);
  if (!t.ok) throw new SessionError("bad_state", t.error);
  await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebSession.update({
      where: { runId, workspaceId },
      data: { control: t.to, controlBy: t.to === "agent" ? null : userId, controlAt: now, ...(t.to === "agent" ? { needsReason: loaded.row.needsReason === "proposal" ? loaded.row.needsReason : null } : {}) },
    }),
  );
  return (await getSessionView(workspaceId, runId))!;
}

export async function setStepMode(workspaceId: string, runId: string, mode: StepMode): Promise<SessionView> {
  if (mode !== "auto" && mode !== "approve_each") throw new SessionError("bad_state", "Unknown step mode.");
  const loaded = await loadSession(workspaceId, runId);
  if (!loaded) throw new SessionError("not_found", "That session was not found.");
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebSession.update({ where: { runId, workspaceId }, data: { stepMode: mode, ...(mode === "auto" ? { pending: null as unknown as Prisma.NullTypes.DbNull, needsReason: loaded.row.needsReason === "proposal" ? null : loaded.row.needsReason } : {}) } }));
  return (await getSessionView(workspaceId, runId))!;
}

export async function setCaps(workspaceId: string, runId: string, caps: { maxSteps?: number; maxSeconds?: number; maxCredits?: number }): Promise<SessionView> {
  const data: Prisma.AgentwebSessionUpdateInput = {};
  for (const k of ["maxSteps", "maxSeconds", "maxCredits"] as const) {
    const v = caps[k];
    if (v === undefined) continue;
    const [lo, hi] = CAP_BOUNDS[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new SessionError("bad_caps", `${k} must be a whole number from ${lo} to ${hi}.`);
    data[k] = v;
  }
  const loaded = await loadSession(workspaceId, runId);
  if (!loaded) throw new SessionError("not_found", "That session was not found.");
  // Raising a cap that stopped the session clears the reason it was waiting for a person.
  if (loaded.row.needsReason?.startsWith("cap_")) data.needsReason = null;
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebSession.update({ where: { runId, workspaceId }, data }));
  return (await getSessionView(workspaceId, runId))!;
}

/** Take the pending proposal out of the session (the caller approves and runs it, or rejects it). */
export async function takePending(workspaceId: string, runId: string, proposalId: string, outcome: { note: string }): Promise<Pending> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await (tx as Tx).agentwebSession.findUnique({ where: { runId, workspaceId } });
    const pending = (row?.pending as Pending | null) ?? null;
    if (!row || row.workspaceId !== workspaceId || !pending || pending.id !== proposalId) throw new SessionError("not_found", "That proposed step is no longer waiting.");
    await (tx as Tx).agentwebSession.update({ where: { runId, workspaceId }, data: { pending: null as unknown as Prisma.NullTypes.DbNull, needsReason: null, lastNote: outcome.note } });
    return pending;
  });
}

export async function endSession(workspaceId: string, runId: string, reason: string): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebSession.updateMany({ where: { runId, workspaceId, endedReason: null }, data: { endedReason: reason.slice(0, 24) } }));
}

export async function getSessionView(workspaceId: string, runId: string): Promise<SessionView | null> {
  const l = await loadSession(workspaceId, runId);
  return l ? viewOf(l.row, l.costMicroUsd) : null;
}

export async function listSessions(workspaceId: string, opts: { liveOnly?: boolean; limit?: number } = {}): Promise<SessionView[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const rows = (await (tx as Tx).agentwebSession.findMany({
      where: { workspaceId, ...(opts.liveOnly ? { run: { status: { in: [...LIVE_RUN_STATUSES] } } } : {}) },
      include: { run: { select: RUN_SELECT } },
      orderBy: { startedAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
    })) as Row[];
    const out: SessionView[] = [];
    for (const r of rows) out.push(viewOf(r, await costOf(tx as Tx, workspaceId, r.runId)));
    return out;
  });
}

export { redactArgs };

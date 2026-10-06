// ShapesOS — runs and missions as RunTimeline steps (pure; no React, no prisma).
//
// Two sources draw as the kit's run timeline (agent-blocks.png):
//   - an AgentRun: its recorded events, in order — the last one is the
//     step the run is on while it is live — then what the mission still has
//     to do, as queued steps;
//   - a Mission: each delegation the lead made (route.N → exec.N or
//     exec.N.error on the orchestrator timeline), then the plan steps not
//     reached yet. Steps that stop for a human carry the asks-first chip.
// Tool calls recorded on an event become a JetBrains Mono block.

import { LEAD_AGENT, SUB_AGENTS, isSubAgentKey, oneLine, type MissionEventInput } from "./agents";
import { fromAgentRunStatus, type AosStatus } from "./status";
import type { TimelineStep, ToolCall } from "./run-steps";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The agent a run belongs to: mission runs are the lead's; the rest by what they do. */
const RUN_AGENTS: Record<string, string> = {
  mission: "Strategist",
  browser: "Browser agent",
  playbook: "Playbook agent",
  follow_up: "Follow-up agent",
  chat: "Strategist",
};

/** Phase 5: a run records which agent ran it; that name wins over the kind's. */
export function runAgentName(kind: string, agentKey?: string | null): string {
  if (agentKey === "lead") return LEAD_AGENT.name;
  if (isSubAgentKey(agentKey)) return SUB_AGENTS[agentKey].name;
  return RUN_AGENTS[kind] ?? "Agent";
}

const KIND_TITLES: Record<string, string> = {
  mission: "Mission run",
  browser: "Browser run",
  playbook: "Playbook run",
  follow_up: "Follow-up run",
  chat: "Task",
};

/** A run's title: the mission it serves, else the task's prompt, else what kind of run it is. */
export function runTitle(kind: string, missionName?: string | null, prompt?: string | null): string {
  const p = prompt ? oneLine(prompt) : "";
  return missionName?.trim() || (p ? (p.length > 80 ? `${p.slice(0, 79)}…` : p) : "") || KIND_TITLES[kind] || "Agent run";
}

/** Phase 5: the prompt/task a chat run was started with (agentState), if any. */
export function runPrompt(agentState: unknown): string | null {
  if (!agentState || typeof agentState !== "object") return null;
  const o = agentState as { prompt?: unknown; task?: unknown };
  const v = typeof o.task === "string" ? o.task : typeof o.prompt === "string" ? o.prompt : null;
  return v && v.trim() ? v.trim() : null;
}

/** "9:05" — local wall-clock time, 24h, no leading zero on the hour. */
export function clockTime(d: Date): string {
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The run's agent state. A live mission run whose mission is waiting on an
 * approval shows Needs you; cancelled runs have no agent state (null).
 */
export function runStatus(status: string, missionPendingApprovals = 0): AosStatus | null {
  const s = fromAgentRunStatus(status);
  if (s === "running" && missionPendingApprovals > 0) return "needs";
  return s;
}

// ---------------------------------------------------------------------------
// Tool calls from an event payload
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function scalar(v: unknown): string | null {
  if (typeof v === "string") return v.trim() ? v : null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

const TOOL_KEYS = ["tool", "toolName", "action"] as const;
const META_KEYS = new Set<string>([
  ...TOOL_KEYS, "result", "durationMs", "progress", "step", "error", "detail", "note",
  // Phase 8 plumbing, not arguments: the loop's event kind / call id, the
  // live-stream marker, and a ship diff (drawn by the Changes review instead).
  "kind", "toolUseId", "recorded", "patch",
]);

/** "0.8 s", "12 s", "2 min" */
export function durationLabel(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/**
 * A tool call recorded on an event: the payload names a tool ("web.search")
 * — its scalar arguments and result are drawn in mono. Null when the event
 * is not a tool call.
 */
export function toolCallFromPayload(payload: unknown): ToolCall | null {
  const p = rec(payload);
  const name = TOOL_KEYS.map((k) => scalar(p[k])).find((v): v is string => !!v);
  if (!name) return null;
  // Text arguments (the query) read first, then numbers and flags (limit);
  // stored JSON does not keep key order, so this keeps the block stable.
  const text: Array<[string, string]> = [];
  const rest: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(p)) {
    if (META_KEYS.has(k)) continue;
    const s = scalar(v);
    if (s !== null) (typeof v === "string" ? text : rest).push([k, s]);
  }
  const args = [...text, ...rest];
  const result = scalar(p.result) ?? undefined;
  return { name, duration: durationLabel(p.durationMs), args: args.length ? args : undefined, result };
}

/** A sentence the event carries for people ("detail" / "note"), if any. */
function prose(payload: unknown): string | null {
  const p = rec(payload);
  const s = scalar(p.detail) ?? scalar(p.note);
  return s ? oneLine(s, 140) : null;
}

/** A non-tool event's scalar payload as one quiet line ("startUrl https://… · headless true"). */
export function payloadFacts(payload: unknown, max = 3): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(rec(payload))) {
    if (k === "progress" || k === "error" || k === "detail" || k === "note") continue;
    const s = scalar(v);
    if (s !== null) parts.push(`${k} ${s.length > 60 ? `${s.slice(0, 59)}…` : s}`);
    if (parts.length >= max) break;
  }
  return parts.length ? parts.join(" · ") : null;
}

function progressFromPayload(payload: unknown): { done: number; total: number } | undefined {
  const pr = rec(rec(payload).progress);
  const done = Number(pr.done);
  const total = Number(pr.total);
  return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? { done, total } : undefined;
}

// ---------------------------------------------------------------------------
// AgentRun → timeline
// ---------------------------------------------------------------------------

export interface RunEventInput {
  id: string;
  seq: number;
  type: string;
  summary: string;
  payload: unknown;
  createdAt: string;
}

export interface UpcomingStep {
  key: string;
  title: string;
  detail?: string | null;
  asksFirst?: boolean;
  asksFirstLabel?: string;
}

export interface TimelineModel {
  steps: TimelineStep[];
  /** Steps finished so far (RunTimeline `completed`). */
  completed: number;
  /** The state the current step takes (RunTimeline `status`). */
  status: AosStatus;
  /** No agent state (cancelled): show a neutral chip, not a status badge. */
  neutral: boolean;
}

/**
 * Recorded run events → timeline steps, oldest first. Phase 17: shared by
 * the run page and the "Load earlier steps" route (older pages are mapped
 * the same way). PURE.
 */
export function eventSteps(input: readonly RunEventInput[], clock: (d: Date) => string = clockTime): TimelineStep[] {
  const events = [...input].sort((a, b) => a.seq - b.seq);
  return events.map((e) => {
    const tool = toolCallFromPayload(e.payload) ?? undefined;
    const err = scalar(rec(e.payload).error);
    return {
      key: e.id,
      title: oneLine(e.summary, 96),
      detail: err ? oneLine(err, 140) : (prose(e.payload) ?? (tool ? null : payloadFacts(e.payload))),
      at: clock(new Date(e.createdAt)),
      tool,
      progress: progressFromPayload(e.payload),
      asksFirst: e.type === "gate",
      asksFirstLabel: e.type === "gate" ? "Waited for your approval" : undefined,
    };
  });
}

export function runTimeline(input: {
  /** prisma AgentRunStatus. */
  status: string;
  events: readonly RunEventInput[];
  upcoming?: readonly UpcomingStep[];
  /** Mission approvals still pending (live runs then show Needs you). */
  pendingApprovals?: number;
  clock?: (d: Date) => string;
}): TimelineModel {
  const steps = eventSteps(input.events, input.clock ?? clockTime);
  const aos = runStatus(input.status, input.pendingApprovals ?? 0);
  const live = aos === "running" || aos === "needs";
  const upcoming: TimelineStep[] = live || aos === "queued"
    ? (input.upcoming ?? []).map((u) => ({
        key: u.key,
        title: u.title,
        detail: u.detail ?? null,
        asksFirst: u.asksFirst,
        asksFirstLabel: u.asksFirstLabel,
      }))
    : [];

  if (aos === null) {
    // Cancelled: what ran is done, nothing is current.
    return { steps, completed: steps.length, status: "queued", neutral: true };
  }
  if (aos === "done") return { steps, completed: steps.length, status: "done", neutral: false };
  if (aos === "queued") {
    const waiting: TimelineStep = { key: "waiting", title: "Waiting to start", detail: "Starts when a worker is free." };
    return { steps: [...steps, waiting, ...upcoming], completed: steps.length, status: "queued", neutral: false };
  }
  // running / needs / failed: the last recorded event is the step it is on.
  if (steps.length === 0) {
    const first: TimelineStep = { key: "starting", title: aos === "failed" ? "Stopped before the first step" : "Starting" };
    return { steps: [first, ...upcoming], completed: 0, status: aos, neutral: false };
  }
  return { steps: [...steps, ...upcoming], completed: steps.length - 1, status: aos, neutral: false };
}

// ---------------------------------------------------------------------------
// Mission → timeline
// ---------------------------------------------------------------------------

export interface PlanStepInput {
  key: string;
  title: string;
  kind?: string;
  executor?: string;
  tier?: number;
}

/** Plan steps that stop for a human: approvals and anything that reaches an outside audience. */
export function planStepAsksFirst(step: PlanStepInput): boolean {
  return step.kind === "approval" || (step.tier ?? 0) >= 2;
}

/** Plan steps not reached yet, as queued timeline steps (at most `max`). */
export function upcomingPlanSteps(plan: readonly PlanStepInput[], reached: number, max = 4): UpcomingStep[] {
  return plan.slice(Math.max(0, reached), Math.max(0, reached) + max).map((s) => {
    const agent = s.executor && isSubAgentKey(s.executor) ? SUB_AGENTS[s.executor].name : null;
    return {
      key: `plan:${s.key}`,
      title: s.title,
      detail: s.kind === "approval" ? "You decide before anything goes out." : agent ? `${agent} takes this step.` : null,
      asksFirst: planStepAsksFirst(s),
      asksFirstLabel: s.kind === "approval" ? "Needs your approval" : "Will ask you before sending",
    };
  });
}

const ROUTE_RE = /^route\.(\d+)$/;
const EXEC_RE = /^exec\.(\d+)$/;
const EXEC_ERR_RE = /^exec\.(\d+)\.error$/;

/**
 * The mission as a timeline: each delegation from the lead is a step (done
 * when its executor reported, failed on an error, current otherwise), then
 * the plan steps not reached yet.
 */
export function missionTimeline(input: {
  events: readonly MissionEventInput[];
  plan: readonly PlanStepInput[];
  /** The mission's agent state (lib/aos/agents deriveMission). */
  status: AosStatus;
  clock?: (d: Date) => string;
  maxUpcoming?: number;
}): { steps: TimelineStep[]; completed: number } {
  const clock = input.clock ?? clockTime;
  const events = [...input.events].sort((a, b) => a.ts.localeCompare(b.ts));
  type Hop = { key: string; title: string; agent: string; detail: string | null; at: string; state: "done" | "failed" | "open" };
  const hops = new Map<string, Hop>();
  for (const ev of events) {
    const step = ev.step ?? "";
    const args = rec(ev.args);
    const obs = rec(ev.observation);
    let m: RegExpMatchArray | null;
    if ((m = step.match(ROUTE_RE)) && isSubAgentKey(args.nextAgent)) {
      const agent = SUB_AGENTS[args.nextAgent].name;
      hops.set(m[1]!, {
        key: step,
        title: oneLine(scalar(args.taskLabel) ?? `Hand off to ${agent}`, 96),
        agent,
        detail: `Strategist handed this to ${agent}.`,
        at: clock(new Date(ev.ts)),
        state: "open",
      });
    } else if ((m = step.match(EXEC_ERR_RE)) && hops.has(m[1]!)) {
      const h = hops.get(m[1]!)!;
      h.state = "failed";
      h.detail = `${h.agent}: ${oneLine(scalar(obs.error) ?? "stopped on an error", 140)}`;
    } else if ((m = step.match(EXEC_RE)) && hops.has(m[1]!)) {
      const h = hops.get(m[1]!)!;
      h.state = "done";
      h.detail = `${h.agent}: ${oneLine(scalar(obs.summary) ?? "finished", 140)}`;
    }
  }
  const list = [...hops.values()];
  // The hop still open says what it is waiting on.
  for (const h of list) {
    if (h.state !== "open") continue;
    if (input.status === "needs") h.detail = `${h.agent} is waiting for your approval.`;
    else if (input.status === "running") h.detail = `${h.agent} is working on it.`;
    else if (input.status === "paused") h.detail = `Paused while ${h.agent} had it.`;
  }
  const steps: TimelineStep[] = list.map((h) => ({ key: h.key, title: h.title, detail: h.detail, at: h.at }));
  let completed = 0;
  while (completed < list.length && list[completed]!.state === "done") completed += 1;

  const live = input.status !== "done";
  // A plan step the lead already handed off is not "to come" again.
  const handed = new Set(list.map((h) => h.title.trim().toLowerCase()));
  const upcoming = live
    ? upcomingPlanSteps(input.plan, Math.max(list.length, completed), (input.maxUpcoming ?? 4) + 1)
        .filter((u) => !handed.has(u.title.trim().toLowerCase()))
        .slice(0, input.maxUpcoming ?? 4)
    : [];
  return {
    steps: [
      ...steps,
      ...upcoming.map((u) => ({ key: u.key, title: u.title, detail: u.detail, asksFirst: u.asksFirst, asksFirstLabel: u.asksFirstLabel })),
    ],
    completed,
  };
}

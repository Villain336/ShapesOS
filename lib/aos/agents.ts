// ShapesOS — one lead agent, sub-agents branching off it (pure derivation).
//
// Owner rule (docs/design/DESIGN.md "Agents: one lead, many sub-agents"):
// each workspace has exactly one lead agent — the orchestrator
// (lib/orchestrator/orchestrator.ts). Its executors are the sub-agents, and
// every agent surface draws the lead first with the sub-agents branching
// under it in the order the lead delegated. No agent has a color of its own:
// color only ever shows an agent's CURRENT state.
//
// The orchestrator logs every delegation on the mission timeline:
//   route.N       actor chief-strategy-agent, args { nextAgent, routingReason, taskLabel }
//   exec.N        actor <executor>, observation { summary }
//   exec.N.error  actor <executor>, observation { error }
//   escalate      paused for the human (observation { terminationCode, detail })
// This module turns Mission rows + those events + AgentRun rows into the
// tree the sidebar, the Overview and the gallery render. Plain data in, plain
// data out (JSON-serializable), no prisma.

import {
  byStatusThenRecent,
  countStatuses,
  fromAgentRunStatus,
  fromMissionStatus,
  rollupStatus,
  statusPriority,
  type AosStatus,
  type StatusCounts,
} from "./status";

export type SubAgentKey = "researcher" | "planner" | "drafter" | "analyst" | "scheduler" | "actor";

export interface AgentProfile {
  name: string;
  description: string;
  /** Tool chips shown on the agent's card (user-facing tool names). */
  tools: string[];
}

/** The lead: the orchestrator ("Chief Strategy Agent" in lib/orchestrator). */
export const LEAD_AGENT: AgentProfile & { key: "lead"; role: string } = {
  key: "lead",
  name: "Strategist",
  role: "Lead agent",
  description: "Takes your goal, hands each step to the right sub-agent and reports back.",
  tools: ["Memory", "Files"],
};

/** The orchestrator's executors (lib/orchestrator/executors), named the way users think of them. */
export const SUB_AGENTS: Readonly<Record<SubAgentKey, AgentProfile>> = Object.freeze({
  researcher: {
    name: "Researcher",
    description: "Finds and reads sources, then writes briefs with citations.",
    tools: ["Web search", "Files", "Memory"],
  },
  planner: {
    name: "Planner",
    description: "Turns a goal into a dated plan of steps.",
    tools: ["Memory", "Calendar"],
  },
  drafter: {
    name: "Writer",
    description: "Drafts emails, posts and docs in your voice, then asks before anything goes out.",
    tools: ["Email", "Files", "Calendar"],
  },
  analyst: {
    name: "Analyst",
    description: "Reads the results and says what worked.",
    tools: ["Code runner", "Files"],
  },
  scheduler: {
    name: "Scheduler",
    description: "Puts approved work on the calendar and runs it on time.",
    tools: ["Calendar"],
  },
  actor: {
    name: "Operator",
    description: "Acts in your connected apps. Anything that writes asks first.",
    tools: ["Email", "Calendar", "Code runner"],
  },
});

export function isSubAgentKey(v: unknown): v is SubAgentKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SUB_AGENTS, v);
}

/** Black monogram tile letter: identity is name + monogram, never a color. */
export function monogram(name: string): string {
  const ch = name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?";
  return ch.toUpperCase();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MissionEventInput {
  ts: string;
  actor: string;
  step: string | null;
  args?: unknown;
  observation?: unknown;
}

export interface MissionInput {
  id: string;
  name: string;
  /** prisma MissionStatus. */
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Steps in the mission's plan snapshot. */
  planTotal: number;
  /** MissionApproval rows still pending. */
  pendingApprovals: number;
  events: MissionEventInput[];
}

export interface AgentRunInput {
  id: string;
  /** prisma AgentRunKind. */
  kind: string;
  /** prisma AgentRunStatus. */
  status: string;
  missionId: string | null;
  createdAt: string;
  endedAt: string | null;
  /** Phase 5: the agent that ran it ("lead" or a sub-agent key). */
  agentKey?: string | null;
  /** Phase 5: the task it was given (chat runs). */
  task?: string | null;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface AgentNode {
  /** "lead", a SubAgentKey, or "run:<id>" for a standalone run. */
  key: string;
  name: string;
  monogram: string;
  isLead: boolean;
  status: AosStatus;
  /** One-line state ("Reading 12 sources", "Waiting for your approval"). */
  line: string;
  href: string | null;
  updatedAt: string;
  missionId: string | null;
  missionName: string | null;
  progress: { done: number; total: number } | null;
  description: string;
  tools: string[];
}

export interface MissionView {
  id: string;
  name: string;
  status: AosStatus;
  line: string;
  href: string;
  updatedAt: string;
  progress: { done: number; total: number } | null;
  pendingApprovals: number;
  /** Latest AgentRun for this mission, when there is one. */
  runId: string | null;
  /** Sub-agents the lead delegated to on this mission, in delegation order. */
  branches: AgentNode[];
}

export interface AgentTree {
  lead: AgentNode;
  /** Sub-agents (and standalone runs) under the lead, in delegation order. */
  branches: AgentNode[];
  missions: MissionView[];
  counts: StatusCounts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** First sentence, trimmed to one line. */
export function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? flat;
  const out = sentence.replace(/[.]$/, "");
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const EXEC_RE = /^exec\.\d+$/;
const EXEC_ERR_RE = /^exec\.\d+\.error$/;
const ROUTE_RE = /^route\.\d+$/;

const RUN_KIND_NAMES: Record<string, string> = {
  browser: "Browser run",
  playbook: "Playbook run",
  follow_up: "Follow-up",
  mission: "Mission run",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// One mission
// ---------------------------------------------------------------------------

export function deriveMission(m: MissionInput, runs: readonly AgentRunInput[] = []): MissionView | null {
  let status = fromMissionStatus(m.status, m.pendingApprovals);
  if (!status) return null;

  const events = [...m.events].sort((a, b) => a.ts.localeCompare(b.ts));
  const branches = new Map<SubAgentKey, AgentNode>();
  let doneCount = 0;
  let escalation: { code: string | null; detail: string | null } | null = null;
  let lastError: string | null = null;

  const touch = (key: SubAgentKey, s: AosStatus, line: string, ts: string) => {
    const profile = SUB_AGENTS[key];
    // Map insertion order = first delegation order; later events only update.
    branches.set(key, {
      key,
      name: profile.name,
      monogram: monogram(profile.name),
      isLead: false,
      status: s,
      line,
      href: `/dashboard/missions/${m.id}`,
      updatedAt: ts,
      missionId: m.id,
      missionName: m.name,
      progress: null,
      description: profile.description,
      tools: profile.tools,
    });
  };

  for (const ev of events) {
    const step = ev.step ?? "";
    const args = rec(ev.args);
    const obs = rec(ev.observation);
    if (ROUTE_RE.test(step) && isSubAgentKey(args.nextAgent)) {
      touch(args.nextAgent, "running", oneLine(str(args.taskLabel) ?? "Working on it"), ev.ts);
      escalation = null;
    } else if (EXEC_ERR_RE.test(step) && isSubAgentKey(ev.actor)) {
      const err = oneLine(str(obs.error) ?? "Stopped on an error");
      touch(ev.actor, "failed", err, ev.ts);
      lastError = err;
    } else if (EXEC_RE.test(step) && isSubAgentKey(ev.actor)) {
      touch(ev.actor, "done", oneLine(str(obs.summary) ?? "Finished"), ev.ts);
      doneCount += 1;
      lastError = null;
    } else if (step === "escalate") {
      escalation = { code: str(obs.terminationCode), detail: str(obs.detail) };
    }
  }

  // The latest AgentRun for the mission refines a live mission's state.
  const missionRuns = runs.filter((r) => r.missionId === m.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestRun = missionRuns[0] ?? null;
  if (status === "running" && latestRun?.status === "failed") status = "failed";
  if (status === "queued" && latestRun?.status === "running") status = "running";

  // An escalation pauses the mission for the human: their decision, or a fix.
  if (escalation && (status === "paused" || status === "running")) {
    status = escalation.code === "consecutive_failures" ? "failed" : "needs";
  }

  // Branch states follow the mission's.
  const list = [...branches.values()];
  for (const b of list) {
    if (status === "done" && (b.status === "running" || b.status === "queued")) b.status = "done";
    if (status === "paused" && b.status === "running") b.status = "paused";
  }
  if (status === "needs" && m.pendingApprovals > 0) {
    const waiting = [...list].reverse().find((b) => b.status === "running");
    if (waiting) {
      waiting.status = "needs";
      waiting.line = "Waiting for your approval";
    }
  }

  const running = [...list].reverse().find((b) => b.status === "running");
  let line: string;
  switch (status) {
    case "needs":
      line =
        m.pendingApprovals > 0
          ? `${plural(m.pendingApprovals, "approval", "approvals")} waiting on you`
          : oneLine(escalation?.detail ?? "Waiting on your decision");
      break;
    case "failed":
      line = lastError ?? oneLine(escalation?.detail ?? "The last run failed");
      break;
    case "running":
      line = running ? `${running.name}: ${running.line}` : "Working on it";
      break;
    case "queued":
      line = "Starts soon";
      break;
    case "paused":
      line = "Paused until you resume it";
      break;
    default:
      line = "Finished";
  }

  const total = Math.max(0, Math.floor(m.planTotal));
  return {
    id: m.id,
    name: m.name,
    status,
    line,
    href: `/dashboard/missions/${m.id}`,
    updatedAt: [m.updatedAt, events.at(-1)?.ts ?? ""].sort().at(-1)!,
    progress: total > 0 ? { done: status === "done" ? total : Math.min(doneCount, total), total } : null,
    pendingApprovals: m.pendingApprovals,
    runId: latestRun?.id ?? null,
    branches: list,
  };
}

// ---------------------------------------------------------------------------
// The whole workspace: lead + branches
// ---------------------------------------------------------------------------

export interface DeriveTreeInput {
  missions: readonly MissionInput[];
  runs: readonly AgentRunInput[];
  now: Date;
  /** How long finished or failed work stays visible (default 24h). */
  recentMs?: number;
}

const DAY_MS = 86_400_000;

function isRecent(iso: string | null, now: Date, recentMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() - t <= recentMs;
}

/** Standalone runs (not tied to a listed mission) hang off the lead too. */
function runNode(r: AgentRunInput, status: AosStatus): AgentNode {
  // Phase 5: a run says which agent ran it; that name wins over the kind's.
  const name =
    r.agentKey === "lead"
      ? LEAD_AGENT.name
      : isSubAgentKey(r.agentKey)
        ? SUB_AGENTS[r.agentKey].name
        : (RUN_KIND_NAMES[r.kind] ?? "Agent run");
  const state =
    status === "running" ? "In progress" : status === "queued" ? "Waiting to start" : status === "failed" ? "Run failed" : "Finished";
  const line = r.task ? `${state} · ${oneLine(r.task, 48)}` : state;
  return {
    key: `run:${r.id}`,
    name,
    monogram: monogram(name),
    isLead: false,
    status,
    line,
    href: `/dashboard/runs/${r.id}`,
    updatedAt: r.endedAt ?? r.createdAt,
    missionId: r.missionId,
    missionName: null,
    progress: null,
    description: "",
    tools: [],
  };
}

export function deriveAgentTree(input: DeriveTreeInput): AgentTree | null {
  const recentMs = input.recentMs ?? DAY_MS;
  const now = input.now;

  const missions: MissionView[] = [];
  for (const m of input.missions) {
    const view = deriveMission(m, input.runs);
    if (!view) continue;
    if (view.status === "done" && !isRecent(view.updatedAt, now, recentMs)) continue;
    missions.push(view);
  }
  missions.sort(byStatusThenRecent);

  const listed = new Set(missions.map((m) => m.id));
  const standalone: AgentNode[] = [];
  for (const r of input.runs) {
    if (r.missionId && listed.has(r.missionId)) continue;
    const s = fromAgentRunStatus(r.status);
    if (!s) continue;
    if ((s === "done" || s === "failed") && !isRecent(r.endedAt ?? r.createdAt, now, recentMs)) continue;
    standalone.push(runNode(r, s));
  }

  if (missions.length === 0 && standalone.length === 0) return null;

  // One node per sub-agent across missions: the state that matters most
  // (needs > failed > running > …), newest on ties; ordered by when the lead
  // first delegated to it.
  const best = new Map<string, AgentNode>();
  for (const mv of missions) {
    for (const b of mv.branches) {
      const prev = best.get(b.key);
      if (
        !prev ||
        statusPriority(b.status) < statusPriority(prev.status) ||
        (statusPriority(b.status) === statusPriority(prev.status) && b.updatedAt > prev.updatedAt)
      ) {
        best.set(b.key, b);
      }
    }
  }
  const subBranches = [...best.values()].sort((a, b) => {
    // The primary mission's delegation order first, then the rest.
    const ia = missions.findIndex((m) => m.branches.some((x) => x.key === a.key));
    const ib = missions.findIndex((m) => m.branches.some((x) => x.key === b.key));
    if (ia !== ib) return ia - ib;
    const m = missions[ia]!;
    return m.branches.findIndex((x) => x.key === a.key) - m.branches.findIndex((x) => x.key === b.key);
  });
  standalone.sort(byStatusThenRecent);
  const branches = [...subBranches, ...standalone];

  const primary = missions[0] ?? null;
  const leadStatus = rollupStatus([...missions.map((m) => m.status), ...standalone.map((s) => s.status)]) ?? "done";
  const pending = missions.reduce((n, m) => n + m.pendingApprovals, 0);
  const failedCount = missions.filter((m) => m.status === "failed").length + standalone.filter((s) => s.status === "failed").length;
  const liveMissions = missions.filter((m) => m.status === "running" || m.status === "needs").length;

  let line: string;
  switch (leadStatus) {
    case "needs":
      line = pending > 0 ? `${plural(pending, "approval", "approvals")} waiting on you` : (primary?.line ?? "Waiting on you");
      break;
    case "failed":
      line = failedCount > 1 ? `${failedCount} runs stopped on errors` : (primary?.status === "failed" ? primary.line : standalone.find((s) => s.status === "failed")?.line ?? "Stopped on an error");
      break;
    case "running":
      line = liveMissions > 1 ? `Working on ${liveMissions} missions` : primary ? `Working on ${primary.name}` : "Working on it";
      break;
    case "queued":
      line = primary ? `Starting ${primary.name}` : "Starting soon";
      break;
    case "paused":
      line = "Paused until you resume";
      break;
    default:
      line = primary ? `Finished ${primary.name}` : "All work finished";
  }

  const lead: AgentNode = {
    key: LEAD_AGENT.key,
    name: LEAD_AGENT.name,
    monogram: monogram(LEAD_AGENT.name),
    isLead: true,
    status: leadStatus,
    line,
    href: primary?.href ?? (standalone[0]?.href ?? null),
    updatedAt: [primary?.updatedAt ?? "", ...standalone.map((s) => s.updatedAt)].sort().at(-1) ?? "",
    missionId: primary?.id ?? null,
    missionName: primary?.name ?? null,
    progress: primary?.progress ?? null,
    description: LEAD_AGENT.description,
    tools: LEAD_AGENT.tools,
  };

  return {
    lead,
    branches,
    missions,
    counts: countStatuses(branches.length ? branches.map((b) => b.status) : [lead.status]),
  };
}

/**
 * The branches to draw when there is room for only `max`: finished ones make
 * way first, and whatever is shown keeps the lead's delegation order.
 */
export function visibleBranches(branches: readonly AgentNode[], max: number): { shown: AgentNode[]; hidden: number } {
  if (max <= 0) return { shown: [], hidden: branches.length };
  if (branches.length <= max) return { shown: [...branches], hidden: 0 };
  const keep = new Set<AgentNode>();
  for (const b of branches) if (b.status !== "done" && keep.size < max) keep.add(b);
  for (const b of branches) if (b.status === "done" && keep.size < max) keep.add(b);
  const shown = branches.filter((b) => keep.has(b));
  return { shown, hidden: branches.length - shown.length };
}

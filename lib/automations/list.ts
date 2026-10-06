// ShapesOS — Phase 18.3 (WS=flow): ONE list over the automation systems that
// already exist. No 8th engine: every row is a view of its own system's row,
// and on/off and "Run now" are DESCRIPTORS of that system's own API route
// (method + url + body) — the Automations app calls exactly those routes, so
// their authorization, validation, kill switch and audit apply unchanged.
//
//   workflow         Workflow (canvas)          PATCH /api/workflows/[id] {enabled} · POST /api/workflows/[id]/run
//   scheduled_skill  ScheduledSkill + SkillRun  PATCH /api/schedules/[id] {workspaceId, status} · (no run-now route: runs on its schedule)
//   ops_workflow     WORKFLOW_REGISTRY + runs   (code-defined; launched with its inputs from Operations → Workflows)
//   autopilot        AutopilotRule + runs       PATCH /api/autopilot/rules/[id] {projectId, enabled} · POST /api/autopilot/runs {projectId, ruleId}
//   activepieces     AutomationFlowBinding      (on/off lives in Activepieces) · POST /api/integrations/activepieces/flows/[flowId]/trigger
//   alert_rule       AlertRule                  PATCH /api/alert-rules/[id] {enabled}
//   cron_job         CRON_JOBS + CronRun        read-only, admins only
//
// The pure mappers (toWorkflowItem …) are unit-tested; loadAutomations()
// reads this workspace's rows under its RLS scope.

import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { CRON_JOBS } from "@/lib/cron/jobs";
import { nextFutureRunAfterInZone, parseCron } from "@/lib/scheduler/cron";
import { WORKFLOW_REGISTRY } from "@/lib/ops/workflows";
import { EVENT_SOURCE_CATALOG } from "@/lib/scheduler/events";
import { NODE_CATALOG } from "@/lib/workflow/catalog";
import { TRIGGERS as ALERT_TRIGGERS } from "@/lib/alerts/triggers";

export const AUTOMATION_KINDS = ["workflow", "scheduled_skill", "ops_workflow", "autopilot", "activepieces", "alert_rule", "cron_job"] as const;
export type AutomationKind = (typeof AUTOMATION_KINDS)[number];

/** A run's state in plain words. Only scheduled-skill runs are AGENT runs (status colour + shape); the rest show neutral text. */
export type RunState = "queued" | "running" | "needs_you" | "done" | "failed" | "cancelled" | "paused";

export interface RouteCall {
  method: "POST" | "PATCH";
  url: string;
  body: Record<string, unknown>;
}

export interface AutomationItem {
  /** "<kind>:<id>" */
  id: string;
  kind: AutomationKind;
  name: string;
  /** Plain-words trigger ("Every day at 09:00 UTC", "Rank drop", "Manual"). */
  trigger: string;
  lastRun: { at: string; state: RunState; agentRun: boolean } | null;
  nextRunAt: string | null;
  /** null = this system has no on/off (code-defined, managed elsewhere). */
  enabled: boolean | null;
  owner: string | null;
  project: { id: string; name: string } | null;
  /** The system's own editor / page. */
  href: string;
  /** The system's own route for on/off (body gets enabled/status merged in by onBody/offBody). */
  toggle: { on: RouteCall; off: RouteCall; minRole: WorkspaceRole } | null;
  /** The system's own route for "Run now". */
  run: (RouteCall & { minRole: WorkspaceRole }) | null;
  /** Why there's no toggle / run here (shown to the person). */
  note: string | null;
  readOnly: boolean;
}

const CRON_EVERY: Record<string, string> = {
  "* * * * *": "Every minute",
  "0 * * * *": "Every hour",
  "0 0 * * *": "Every day at 00:00",
};

/** "0 9 * * 1" in Europe/Madrid → "Cron 0 9 * * 1 (Europe/Madrid)" — the cron itself is the honest description. */
export function describeCron(expr: string | null | undefined, tz = "UTC"): string {
  if (!expr) return "Manual";
  return CRON_EVERY[expr.trim()] ? `${CRON_EVERY[expr.trim()]} (${tz})` : `Cron ${expr.trim()} (${tz})`;
}

export function nextCronRun(expr: string | null | undefined, tz: string, now = new Date()): string | null {
  if (!expr) return null;
  try {
    return nextFutureRunAfterInZone(parseCron(expr), now, now, tz || "UTC").toISOString();
  } catch {
    return null;
  }
}

const WORKFLOW_RUN_STATE: Record<string, RunState> = { queued: "queued", running: "running", waiting_approval: "needs_you", succeeded: "done", failed: "failed", cancelled: "cancelled" };
const SKILL_RUN_STATE: Record<string, RunState> = { pending: "queued", awaiting_approval: "needs_you", approved: "queued", running: "running", succeeded: "done", failed: "failed", rejected: "cancelled", cancelled: "cancelled", blocked: "failed" };
const AUTOPILOT_RUN_STATE: Record<string, RunState> = { running: "running", completed: "done", failed: "failed", killed: "cancelled" };
const OPS_RUN_STATE: Record<string, RunState> = { running: "running", succeeded: "done", failed: "failed", compensated: "cancelled" };
const CRON_RUN_STATE: Record<string, RunState> = { running: "running", ok: "done", failed: "failed", timeout: "failed" };

const canvasTriggerLabel = (type: string) => NODE_CATALOG.trigger.find((n) => n.type === type)?.label ?? type;

// ── Pure mappers (unit-tested) ──────────────────────────────────────────────

export interface WorkflowRow {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  schedule: string | null;
  timezone: string;
  createdBy: string | null;
  project: { id: string; name: string };
  nodes: Array<{ kind: string; type: string }>;
  lastRun: { startedAt: Date; status: string } | null;
}

export function toWorkflowItem(w: WorkflowRow, now = new Date()): AutomationItem {
  const triggers = w.nodes.filter((n) => n.kind === "trigger").map((n) => (n.type === "schedule" ? describeCron(w.schedule, w.timezone) : canvasTriggerLabel(n.type)));
  const active = w.enabled && w.status === "active";
  return {
    id: `workflow:${w.id}`,
    kind: "workflow",
    name: w.name,
    trigger: triggers.length ? [...new Set(triggers)].join(" · ") : w.schedule ? describeCron(w.schedule, w.timezone) : "Manual",
    lastRun: w.lastRun ? { at: w.lastRun.startedAt.toISOString(), state: WORKFLOW_RUN_STATE[w.lastRun.status] ?? "queued", agentRun: false } : null,
    nextRunAt: active ? nextCronRun(w.schedule, w.timezone, now) : null,
    enabled: active,
    owner: w.createdBy,
    project: w.project,
    href: `/dashboard/projects/${encodeURIComponent(w.project.id)}/automations?workflow=${encodeURIComponent(w.id)}`,
    // The canvas route turns a draft/paused workflow on through status, and enabled for the switch itself.
    toggle: {
      on: { method: "PATCH", url: `/api/workflows/${encodeURIComponent(w.id)}`, body: { enabled: true, status: "active" } },
      off: { method: "PATCH", url: `/api/workflows/${encodeURIComponent(w.id)}`, body: { enabled: false } },
      minRole: "editor",
    },
    run: { method: "POST", url: `/api/workflows/${encodeURIComponent(w.id)}/run`, body: {}, minRole: "editor" },
    note: null,
    readOnly: false,
  };
}

export interface ScheduleRow {
  id: string;
  workspaceId: string;
  status: string;
  triggerType: string;
  cronExpr: string | null;
  timezone: string;
  eventSource: string | null;
  nextRunAt: Date | null;
  createdBy: string;
  skill: { name: string };
  project: { id: string; name: string } | null;
  lastRun: { startedAt: Date; status: string } | null;
}

export function toScheduleItem(s: ScheduleRow): AutomationItem {
  const eventLabel = EVENT_SOURCE_CATALOG.find((e) => e.source === s.eventSource)?.label ?? s.eventSource ?? "Event";
  // Project schedules have their own page; workspace-wide ones open here (the Automations app's detail).
  const href = s.project ? `/dashboard/projects/${encodeURIComponent(s.project.id)}/automations/schedules/${encodeURIComponent(s.id)}` : `/dashboard/automations?item=scheduled_skill:${encodeURIComponent(s.id)}`;
  const url = `/api/schedules/${encodeURIComponent(s.id)}`;
  return {
    id: `scheduled_skill:${s.id}`,
    kind: "scheduled_skill",
    name: s.skill.name,
    trigger: s.triggerType === "cron" ? describeCron(s.cronExpr, s.timezone) : `When: ${eventLabel}`,
    lastRun: s.lastRun ? { at: s.lastRun.startedAt.toISOString(), state: SKILL_RUN_STATE[s.lastRun.status] ?? "queued", agentRun: true } : null,
    nextRunAt: s.status === "active" ? (s.nextRunAt?.toISOString() ?? null) : null,
    enabled: s.status === "active",
    owner: s.createdBy,
    project: s.project,
    href,
    // Same grants as create (project editor+ / skills.install) — the route checks them.
    toggle: {
      on: { method: "PATCH", url, body: { workspaceId: s.workspaceId, status: "active" } },
      off: { method: "PATCH", url, body: { workspaceId: s.workspaceId, status: "paused" } },
      minRole: "editor",
    },
    run: null,
    note: "Runs on its schedule or event; there is no run-now for schedules.",
    readOnly: false,
  };
}

export interface AutopilotRow {
  id: string;
  name: string;
  source: string;
  cadence: string;
  enabled: boolean;
  project: { id: string; name: string };
  lastRun: { startedAt: Date; status: string } | null;
}

export function toAutopilotItem(r: AutopilotRow): AutomationItem {
  const url = `/api/autopilot/rules/${encodeURIComponent(r.id)}`;
  return {
    id: `autopilot:${r.id}`,
    kind: "autopilot",
    name: r.name,
    trigger: r.cadence === "manual" ? "Manual" : r.cadence === "daily" ? "Every day" : "Every week",
    lastRun: r.lastRun ? { at: r.lastRun.startedAt.toISOString(), state: AUTOPILOT_RUN_STATE[r.lastRun.status] ?? "queued", agentRun: false } : null,
    nextRunAt: null,
    enabled: r.enabled,
    owner: null,
    project: r.project,
    href: `/dashboard/projects/${encodeURIComponent(r.project.id)}/autopilot?rule=${encodeURIComponent(r.id)}`,
    toggle: {
      on: { method: "PATCH", url, body: { projectId: r.project.id, enabled: true } },
      off: { method: "PATCH", url, body: { projectId: r.project.id, enabled: false } },
      minRole: "editor",
    },
    run: { method: "POST", url: "/api/autopilot/runs", body: { projectId: r.project.id, ruleId: r.id }, minRole: "editor" },
    note: null,
    readOnly: false,
  };
}

export function toOpsWorkflowItems(lastRuns: Map<string, { createdAt: Date; status: string }>): AutomationItem[] {
  return Object.values(WORKFLOW_REGISTRY).map((def) => {
    const last = lastRuns.get(def.name);
    return {
      id: `ops_workflow:${def.name}`,
      kind: "ops_workflow" as const,
      name: def.name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
      trigger: "Started from Operations (with its inputs)",
      lastRun: last ? { at: last.createdAt.toISOString(), state: OPS_RUN_STATE[last.status] ?? "queued", agentRun: false } : null,
      nextRunAt: null,
      enabled: null,
      owner: null,
      project: null,
      href: "/dashboard/ops/workflows",
      toggle: null,
      run: null,
      note: "Built in; it needs an order and an amount, so it starts from Operations → Workflows (money steps wait for approval).",
      readOnly: false,
    };
  });
}

export function toActivepiecesItem(b: { id: string; flowId: string; boundBy: string; createdAt: Date }): AutomationItem {
  return {
    id: `activepieces:${b.id}`,
    kind: "activepieces",
    name: `Activepieces flow ${b.flowId}`,
    trigger: "Webhook (Activepieces)",
    lastRun: null,
    nextRunAt: null,
    enabled: null,
    owner: b.boundBy,
    project: null,
    href: "/dashboard/settings/providers",
    toggle: null,
    run: { method: "POST", url: `/api/integrations/activepieces/flows/${encodeURIComponent(b.flowId)}/trigger`, body: {}, minRole: "editor" },
    note: "Turn this flow on or off in Activepieces.",
    readOnly: false,
  };
}

export interface AlertRuleRow {
  id: string;
  name: string;
  trigger: string;
  enabled: boolean;
  lastFiredAt: Date | null;
}

export function toAlertRuleItem(r: AlertRuleRow): AutomationItem {
  const url = `/api/alert-rules/${encodeURIComponent(r.id)}`;
  return {
    id: `alert_rule:${r.id}`,
    kind: "alert_rule",
    name: r.name,
    trigger: ALERT_TRIGGERS.find((t) => t.key === r.trigger)?.label ?? r.trigger,
    lastRun: r.lastFiredAt ? { at: r.lastFiredAt.toISOString(), state: "done", agentRun: false } : null,
    nextRunAt: null,
    enabled: r.enabled,
    owner: null,
    project: null,
    href: "/dashboard/settings/alerts",
    toggle: { on: { method: "PATCH", url, body: { enabled: true } }, off: { method: "PATCH", url, body: { enabled: false } }, minRole: "editor" },
    run: null,
    note: null,
    readOnly: false,
  };
}

export function toCronJobItems(last: Map<string, { startedAt: Date; status: string }>, now = new Date()): AutomationItem[] {
  return CRON_JOBS.map((j) => {
    const l = last.get(j.key);
    return {
      id: `cron_job:${j.key}`,
      kind: "cron_job" as const,
      name: j.key,
      trigger: describeCron(j.cron, "UTC"),
      lastRun: l ? { at: l.startedAt.toISOString(), state: CRON_RUN_STATE[l.status] ?? "queued", agentRun: false } : null,
      nextRunAt: nextCronRun(j.cron, "UTC", now),
      enabled: null,
      owner: null,
      project: null,
      href: "/dashboard/activity",
      toggle: null,
      run: null,
      note: "A system job (read-only).",
      readOnly: true,
    };
  });
}

/** May this role use a descriptor's route? (UI hint only — the route decides.) */
export function canUse(role: WorkspaceRole | null | undefined, minRole: WorkspaceRole): boolean {
  return !!role && roleAtLeast(role, minRole);
}

export interface AutomationFilter {
  kind?: AutomationKind | "all";
  q?: string;
  state?: "all" | "on" | "off";
  projectId?: string | null;
}

export function filterAutomations(items: AutomationItem[], f: AutomationFilter): AutomationItem[] {
  const q = (f.q ?? "").trim().toLowerCase();
  return items.filter(
    (i) =>
      (!f.kind || f.kind === "all" || i.kind === f.kind) &&
      (!f.projectId || i.project?.id === f.projectId) &&
      (!f.state || f.state === "all" || (f.state === "on" ? i.enabled === true : i.enabled === false)) &&
      (!q || i.name.toLowerCase().includes(q) || i.trigger.toLowerCase().includes(q)),
  );
}

// ── Loader ──────────────────────────────────────────────────────────────────

/** A project is named by its domain. */
const projectRef = (p: { id: string; domain: string }) => ({ id: p.id, name: p.domain });

export interface AutomationActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

/** Every automation in THIS workspace (system cron jobs only for admins). */
export async function loadAutomations(actor: AutomationActor, now = new Date()): Promise<{ items: AutomationItem[]; unavailable: Array<{ kind: AutomationKind; reason: string }> }> {
  const unavailable: Array<{ kind: AutomationKind; reason: string }> = [];
  const safe = async <T>(kind: AutomationKind, fn: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      unavailable.push({ kind, reason: err instanceof Error ? err.message.slice(0, 200) : "unavailable" });
      return empty;
    }
  };
  const ws = actor.workspaceId;
  const [workflows, schedules, autopilot, opsRuns, bindings, alertRules, cronRuns] = await Promise.all([
    safe("workflow", () =>
      withWorkspaceScope(ws, (tx) =>
        tx.workflow.findMany({
          where: { project: { workspaceId: ws }, status: { not: "archived" } },
          orderBy: { updatedAt: "desc" },
          take: 500,
          select: {
            id: true, name: true, status: true, enabled: true, schedule: true, timezone: true, createdBy: true,
            project: { select: { id: true, domain: true } },
            nodes: { where: { kind: "trigger" }, select: { kind: true, type: true } },
            runs: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true, status: true } },
          },
        }),
      ), []),
    safe("scheduled_skill", () =>
      withWorkspaceScope(ws, (tx) =>
        tx.scheduledSkill.findMany({
          where: { workspaceId: ws },
          orderBy: { createdAt: "desc" },
          take: 500,
          select: {
            id: true, workspaceId: true, status: true, triggerType: true, cronExpr: true, timezone: true, eventSource: true, nextRunAt: true, createdBy: true,
            skill: { select: { name: true } },
            project: { select: { id: true, domain: true } },
            runs: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true, status: true } },
          },
        }),
      ), []),
    safe("autopilot", () =>
      withWorkspaceScope(ws, (tx) =>
        tx.autopilotRule.findMany({
          where: { project: { workspaceId: ws } },
          orderBy: { createdAt: "desc" },
          take: 500,
          select: {
            id: true, name: true, source: true, cadence: true, enabled: true,
            project: { select: { id: true, domain: true } },
            runs: { orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true, status: true } },
          },
        }),
      ), []),
    safe("ops_workflow", () =>
      withWorkspaceScope(ws, (tx) =>
        tx.opsWorkflowRun.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 100, select: { workflowName: true, createdAt: true, status: true } }),
      ), []),
    safe("activepieces", () => withWorkspaceScope(ws, (tx) => tx.automationFlowBinding.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 200 })), []),
    safe("alert_rule", () =>
      withWorkspaceScope(ws, (tx) => tx.alertRule.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 500, select: { id: true, name: true, trigger: true, enabled: true, lastFiredAt: true } })),
      []),
    roleAtLeast(actor.role, "admin")
      ? safe("cron_job", () =>
          prisma.$queryRaw<Array<{ job: string; started_at: Date; status: string }>>`
            SELECT DISTINCT ON (job) job, started_at, status::text AS status FROM cron_runs ORDER BY job, started_at DESC`,
        [])
      : Promise.resolve(null),
  ]);

  const opsLast = new Map<string, { createdAt: Date; status: string }>();
  for (const r of opsRuns) if (!opsLast.has(r.workflowName)) opsLast.set(r.workflowName, { createdAt: r.createdAt, status: r.status });

  const items: AutomationItem[] = [
    ...workflows.map((w) => toWorkflowItem({ ...w, project: projectRef(w.project), lastRun: w.runs[0] ?? null }, now)),
    ...schedules.map((s) => toScheduleItem({ ...s, project: s.project ? projectRef(s.project) : null, lastRun: s.runs[0] ?? null })),
    ...autopilot.map((r) => toAutopilotItem({ ...r, project: projectRef(r.project), lastRun: r.runs[0] ?? null })),
    ...toOpsWorkflowItems(opsLast),
    ...bindings.map(toActivepiecesItem),
    ...alertRules.map(toAlertRuleItem),
  ];
  if (cronRuns) items.push(...toCronJobItems(new Map(cronRuns.map((r) => [r.job, { startedAt: r.started_at, status: r.status }])), now));
  return { items, unavailable };
}

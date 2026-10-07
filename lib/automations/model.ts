// ShapesOS — Phase 18.3 (WS=flow): the Automations app's client-safe model
// (types and pure helpers; no server imports). lib/automations/list.ts loads
// the rows; components/automations/AutomationsApp.tsx renders them.

import type { WorkspaceRole } from "@prisma/client";

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

/** May this role use a descriptor's route? (UI hint only — the route decides.) */
const RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function canUse(role: WorkspaceRole | null | undefined, minRole: WorkspaceRole): boolean {
  return !!role && (RANK[role] ?? 0) >= (RANK[minRole] ?? 9);
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


/** Shape of a workflow draft the graph body needs (see lib/automations/describe.ts WorkflowDraft). */
export interface GraphDraft {
  nodes: Array<{ key: string; kind: string; type: string; label: string; config: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; label?: "true" | "false" | null }>;
}

/** The PUT /api/workflows/[id]/nodes body for a workflow draft (tmp- ids, laid out left to right). */
export function workflowGraphBody(w: GraphDraft): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } {
  const depth = new Map<string, number>(w.nodes.map((n) => [n.key, 0]));
  for (let pass = 0; pass < w.nodes.length; pass++) for (const e of w.edges) depth.set(e.to, Math.max(depth.get(e.to) ?? 0, (depth.get(e.from) ?? 0) + 1));
  const row = new Map<number, number>();
  return {
    nodes: w.nodes.map((n) => {
      const d = depth.get(n.key) ?? 0;
      const r = row.get(d) ?? 0;
      row.set(d, r + 1);
      return { id: `tmp-${n.key}`, kind: n.kind, type: n.type, label: n.label, config: n.config, positionX: 80 + d * 280, positionY: 80 + r * 140 };
    }),
    edges: w.edges.map((e) => ({ sourceNodeId: `tmp-${e.from}`, targetNodeId: `tmp-${e.to}`, label: e.label ?? null })),
  };
}


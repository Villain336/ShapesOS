// ShapesOS — public status page: component health derived from live signals
// (beta readiness, WS=legal).
//
// PURE rules over the signals the app already exposes: the readiness report
// behind GET /api/health (database + migrations + draining) and the agent
// queue (running jobs, last worker heartbeat, waiting jobs and the oldest
// wait). Thresholds are named constants so the page can say them. A platform
// operator can set a manual state on a component (status_components); it
// overrides the derived state and carries a note. Missing signals are
// "unknown", never "operational".
//
// Design note: the Agentic OS status colours and shapes mean AGENT states
// only (docs/design/DESIGN.md). Component health here is shown as neutral
// text pills with a Lucide icon, like the twin's entity states, never with
// the running/needs/done/failed colours.

import type { HealthReport } from "@/lib/observability/health";

export type ComponentState = "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance" | "unknown";

export const COMPONENT_STATES: readonly ComponentState[] = ["operational", "degraded", "partial_outage", "major_outage", "maintenance", "unknown"];

/** Severity order for the overall status (worst wins). */
const SEVERITY: Record<ComponentState, number> = {
  operational: 0,
  unknown: 1,
  maintenance: 2,
  degraded: 3,
  partial_outage: 4,
  major_outage: 5,
};

export interface ComponentDef {
  key: "web" | "database" | "worker" | "queue";
  name: string;
  description: string;
}

export const DEFAULT_COMPONENTS: readonly ComponentDef[] = [
  { key: "web", name: "Web app and API", description: "The site, the dashboard and the API (GET /api/health)." },
  { key: "database", name: "Database", description: "PostgreSQL answers within 2 s and every shipped migration is applied." },
  { key: "worker", name: "Agent worker", description: "The background worker that runs agent jobs, heartbeating every 10 s." },
  { key: "queue", name: "Job queue", description: "How long agent jobs wait before a worker picks them up." },
];

/** A worker heartbeat older than this while jobs run means it is stuck. */
export const HEARTBEAT_STALE_MS = 90_000;
/** Waiting jobs older than this degrade the queue. */
export const QUEUE_DEGRADED_MS = 2 * 60_000;
/** Waiting jobs older than this are a partial outage (and, with no worker, an outage of the worker). */
export const QUEUE_OUTAGE_MS = 15 * 60_000;

export interface ReadinessSignal {
  status: HealthReport["status"];
  draining?: true;
  checks: HealthReport["checks"];
}

export interface WorkerSignal {
  mode: "internal" | "external" | "off";
  /** Jobs currently running (system-wide). */
  runningJobs: number;
  /** Age of the most recent heartbeat on a running job, ms; null when none runs. */
  lastHeartbeatMs: number | null;
}

export interface QueueSignal {
  /** Jobs queued and due now (system-wide). */
  depth: number;
  /** Age of the oldest due job, ms; null when none. */
  oldestQueuedMs: number | null;
  /** Jobs that ran out of attempts in the last 24 h. */
  deadJobs24h: number;
}

export interface LiveSignals {
  readiness: ReadinessSignal | null;
  worker: WorkerSignal | null;
  queue: QueueSignal | null;
}

export interface ManualOverride {
  state: ComponentState;
  note: string | null;
}

export interface ComponentStatus extends ComponentDef {
  state: ComponentState;
  /** One line on why (derived detail, or the operator's note). */
  note: string | null;
  manual: boolean;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m === 1 ? "1 minute" : `${m} minutes`;
}

function deriveWeb(r: ReadinessSignal | null): [ComponentState, string | null] {
  if (!r) return ["unknown", "No readiness report."];
  if (r.draining) return ["degraded", "An instance is restarting and draining its requests."];
  if (r.checks.database.status !== "ok") return ["degraded", "Serving, but the database is unreachable."];
  return ["operational", null];
}

function deriveDatabase(r: ReadinessSignal | null): [ComponentState, string | null] {
  if (!r) return ["unknown", "No readiness report."];
  const { database, migrations } = r.checks;
  if (database.status === "fail") return ["major_outage", "The database did not answer within 2 s."];
  if (database.status === "unknown") return ["unknown", "The database check did not run."];
  if (migrations.status === "fail") {
    const parts = [migrations.pending ? `${migrations.pending} pending` : "", migrations.failed ? `${migrations.failed} failed` : ""].filter(Boolean);
    return ["degraded", `Migrations need attention (${parts.join(", ")}).`];
  }
  return ["operational", database.latencyMs !== null ? `Answered in ${database.latencyMs} ms.` : null];
}

function deriveWorker(w: WorkerSignal | null, q: QueueSignal | null): [ComponentState, string | null] {
  if (!w) return ["unknown", "No worker signal."];
  if (w.mode === "off") return ["maintenance", "Background work is switched off on this install."];
  if (w.runningJobs > 0) {
    if (w.lastHeartbeatMs !== null && w.lastHeartbeatMs > HEARTBEAT_STALE_MS) {
      return ["degraded", `Last heartbeat ${minutes(w.lastHeartbeatMs)} ago while ${w.runningJobs} job(s) run.`];
    }
    return ["operational", `${w.runningJobs} job(s) running.`];
  }
  if (q && q.depth > 0 && q.oldestQueuedMs !== null && q.oldestQueuedMs > QUEUE_OUTAGE_MS) {
    return ["major_outage", `${q.depth} job(s) have waited ${minutes(q.oldestQueuedMs)} with no worker picking them up.`];
  }
  return ["operational", "Idle: no jobs running."];
}

function deriveQueue(q: QueueSignal | null): [ComponentState, string | null] {
  if (!q) return ["unknown", "No queue signal."];
  if (q.depth === 0 || q.oldestQueuedMs === null) return ["operational", q.deadJobs24h ? `Nothing waiting; ${q.deadJobs24h} job(s) failed for good in the last 24 h.` : "Nothing waiting."];
  if (q.oldestQueuedMs > QUEUE_OUTAGE_MS) return ["partial_outage", `${q.depth} waiting; the oldest for ${minutes(q.oldestQueuedMs)}.`];
  if (q.oldestQueuedMs > QUEUE_DEGRADED_MS) return ["degraded", `${q.depth} waiting; the oldest for ${minutes(q.oldestQueuedMs)}.`];
  return ["operational", `${q.depth} waiting; the oldest for ${minutes(q.oldestQueuedMs)}.`];
}

/** The four components with their derived (or manually set) state. */
export function deriveComponents(signals: LiveSignals, overrides: Partial<Record<ComponentDef["key"], ManualOverride>>): ComponentStatus[] {
  return DEFAULT_COMPONENTS.map((def) => {
    const manual = overrides[def.key];
    if (manual) return { ...def, state: manual.state, note: manual.note, manual: true };
    const [state, note] =
      def.key === "web"
        ? deriveWeb(signals.readiness)
        : def.key === "database"
          ? deriveDatabase(signals.readiness)
          : def.key === "worker"
            ? deriveWorker(signals.worker, signals.queue)
            : deriveQueue(signals.queue);
    return { ...def, state, note, manual: false };
  });
}

/** The worst component state. */
export function overallStatus(components: readonly ComponentStatus[]): ComponentState {
  let worst: ComponentState = "operational";
  for (const c of components) if (SEVERITY[c.state] > SEVERITY[worst]) worst = c.state;
  return worst;
}

export function isComponentState(v: unknown): v is ComponentState {
  return typeof v === "string" && (COMPONENT_STATES as readonly string[]).includes(v);
}

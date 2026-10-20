// ShapesOS — Phase 18.3 (WS=trust): one audit timeline, the pure half.
//
// The Privacy & Security center reads every existing audit trail through ONE
// read-side view — no new audit table, no copied data. Each source has an
// adapter (./sources.server.ts) that reads its own table, scoped to the
// workspace, and a NORMALISER here that maps a row to the common shape:
//
//   { at, actor: { kind: person | agent | system, id, label }, action,
//     target, source, link, summary }
//
// Agent run events contribute their short summary only (never the payload).
// Pure (no Prisma; the cursor uses Node's Buffer): the normalisers, the actor
// classifier, the cursor and the CSV row are unit-tested
// (lib/audit-timeline/__tests__).

export const TIMELINE_SOURCES = [
  "file_change_log",
  "agent_run_event",
  "ops_audit_event",
  "composio_action_log",
  "command_audit",
  "workspace_lifecycle_event",
  // Hash-chained (tamper-evident) trails.
  "mission_event",
  "media_audit_event",
  "authority_audit_event",
  "flywheel_audit_event",
  "esign_audit_event",
] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/** Sources whose rows chain to the one before (prevHash → eventHash). */
export const HASH_CHAINED_SOURCES: readonly TimelineSource[] = [
  "mission_event",
  "media_audit_event",
  "authority_audit_event",
  "flywheel_audit_event",
  "esign_audit_event",
];

export function isTimelineSource(v: unknown): v is TimelineSource {
  return typeof v === "string" && (TIMELINE_SOURCES as readonly string[]).includes(v);
}

export type ActorKind = "person" | "agent" | "system";
export const ACTOR_KINDS: readonly ActorKind[] = ["person", "agent", "system"];

export interface TimelineActor {
  kind: ActorKind;
  /** A member's user id (person), the agent key / surface (agent), or null. */
  id: string | null;
  /** What to show; members get their name or email later (resolveActorLabels). */
  label: string;
}

export interface TimelineEntry {
  /** Unique across sources: `${source}:${rowId}`. */
  key: string;
  at: string;
  actor: TimelineActor;
  action: string;
  target: string | null;
  source: TimelineSource;
  /** Same-app dashboard link to the thing, when there is one. */
  link: string | null;
  summary: string | null;
}

const SYSTEM_WORDS = new Set(["system", "cron", "scheduler", "webhook", "stripe", "worker", "operator", "platform"]);

/**
 * Who did it, from the raw actor strings the trails store: a member's user id
 * ("u_…", "google:123", "email:ada@x.com"), an agent ("agent:…", "ai",
 * "lead", "fix_agent", "workflow", "autopilot", "researcher" …) or the system
 * ("system", "cron", "scheduler" …). PURE.
 */
export function classifyActor(raw: string | null | undefined, agentKeys: readonly string[] = DEFAULT_AGENT_WORDS): TimelineActor {
  const v = (raw ?? "").trim();
  if (!v) return { kind: "system", id: null, label: "System" };
  const first = v.split(/\s+/)[0]!;
  const lower = first.toLowerCase();
  if (SYSTEM_WORDS.has(lower) || lower.startsWith("cron:") || lower.startsWith("system:")) {
    return { kind: "system", id: null, label: lower.startsWith("cron") ? "Scheduled job" : "System" };
  }
  if (lower.startsWith("agent:") || lower.startsWith("agent_") || lower === "agent") {
    const id = first.slice(first.indexOf(":") + 1) || "agent";
    return { kind: "agent", id, label: humanize(id === "agent" ? "Agent" : id) };
  }
  if (agentKeys.includes(lower)) return { kind: "agent", id: lower, label: AGENT_LABELS[lower] ?? humanize(lower) };
  return { kind: "person", id: first, label: first.includes("@") ? first.replace(/^email:/, "") : "Member" };
}

const AGENT_LABELS: Record<string, string> = {
  ai: "Agent",
  lead: "Lead agent",
  fix_agent: "Fix agent",
  workflow: "Workflow",
  autopilot: "Autopilot",
  orchestrator: "Lead agent",
};
const DEFAULT_AGENT_WORDS = ["ai", "lead", "fix_agent", "workflow", "autopilot", "orchestrator", "researcher", "planner", "drafter", "analyst", "scheduler_agent", "actor"];

/** "send_email" → "Send email". PURE. */
export function humanize(s: string): string {
  const t = s.replace(/[_.:-]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : s;
}

function clip(s: unknown, n = 300): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null;
}

const enc = encodeURIComponent;
const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

// ---------------------------------------------------------------------------
// Normalisers — one per source. Rows are the adapter's select shapes.
// ---------------------------------------------------------------------------

export function fromFileChangeLog(r: {
  id: string;
  createdAt: Date;
  actor: string;
  action: string;
  summary: string;
  filePath: string;
  projectId: string | null;
  approvedBy: string | null;
}): TimelineEntry {
  const actor: TimelineActor =
    r.actor === "user"
      ? r.approvedBy
        ? { kind: "person", id: r.approvedBy, label: "Member" }
        : { kind: "person", id: null, label: "Member" }
      : r.actor === "ai"
        ? { kind: "agent", id: "ai", label: "Agent" }
        : r.actor === "fix_agent"
          ? { kind: "agent", id: "fix_agent", label: "Fix agent" }
          : { kind: "system", id: null, label: "System" };
  const target = r.filePath && r.filePath !== "(workspace)" && !r.filePath.startsWith("m21:") ? r.filePath : null;
  return {
    key: `file_change_log:${r.id}`,
    at: iso(r.createdAt),
    actor,
    action: humanize(r.action),
    target,
    source: "file_change_log",
    link: r.projectId ? `/dashboard/projects/${enc(r.projectId)}` : null,
    summary: clip(r.summary),
  };
}

export function fromAgentRunEvent(r: {
  id: string;
  createdAt: Date;
  runId: string;
  type: string;
  summary: string;
  run: { agentKey: string | null; kind: string; startedBy: string } | null;
}): TimelineEntry {
  const agent = r.run?.agentKey ?? "lead";
  return {
    key: `agent_run_event:${r.id}`,
    at: iso(r.createdAt),
    actor: { kind: "agent", id: agent, label: AGENT_LABELS[agent] ?? humanize(agent) },
    action: r.type === "gate" ? "Approval gate" : r.type === "browser" ? "Browser step" : r.type === "note" ? "Note" : "Agent step",
    target: r.run ? `${humanize(r.run.kind)} run` : null,
    source: "agent_run_event",
    link: `/dashboard/runs/${enc(r.runId)}`,
    // Summaries only — the payload (tool arguments, results) never leaves the run page.
    summary: clip(r.summary, 200),
  };
}

export function fromOpsAuditEvent(r: { id: string; createdAt: Date; entity: string; entityId: string | null; action: string; actor: string; summary: string }): TimelineEntry {
  return {
    key: `ops_audit_event:${r.id}`,
    at: iso(r.createdAt),
    actor: classifyActor(r.actor),
    action: humanize(r.action),
    target: r.entityId ? `${humanize(r.entity)} ${r.entityId}` : humanize(r.entity),
    source: "ops_audit_event",
    link: `/dashboard/ops/${enc(r.entity)}${r.entityId ? `?id=${enc(r.entityId)}` : ""}`,
    summary: clip(r.summary),
  };
}

export function fromComposioActionLog(r: { id: string; createdAt: Date; appKey: string; toolName: string; status: string; riskTier: string; executedBy: string }): TimelineEntry {
  return {
    key: `composio_action_log:${r.id}`,
    at: iso(r.createdAt),
    actor: classifyActor(r.executedBy),
    action: `${humanize(r.toolName.toLowerCase())} (${r.status})`,
    target: humanize(r.appKey),
    source: "composio_action_log",
    link: "/dashboard/settings/connectors",
    summary: `Risk ${r.riskTier}`,
  };
}

export function fromCommandAudit(r: { id: string; createdAt: Date; userId: string; kind: string; templateId: string | null; resultSummary: string | null }): TimelineEntry {
  return {
    key: `command_audit:${r.id}`,
    at: iso(r.createdAt),
    actor: { kind: "person", id: r.userId, label: "Member" },
    action: `Command: ${humanize(r.kind)}`,
    target: r.templateId,
    source: "command_audit",
    link: null,
    summary: clip(r.resultSummary),
  };
}

export function fromWorkspaceLifecycleEvent(r: { id: string; createdAt: Date; actorUserId: string; action: string; workspaceName: string }): TimelineEntry {
  return {
    key: `workspace_lifecycle_event:${r.id}`,
    at: iso(r.createdAt),
    actor: { kind: "person", id: r.actorUserId, label: "Member" },
    action: `Workspace ${r.action}`,
    target: r.workspaceName,
    source: "workspace_lifecycle_event",
    link: "/dashboard/settings/workspace",
    summary: null,
  };
}

export function fromMissionEvent(r: { id: string; ts: Date; missionId: string; actor: string; step: string | null; tool: string | null }): TimelineEntry {
  return {
    key: `mission_event:${r.id}`,
    at: iso(r.ts),
    actor: classifyActor(r.actor),
    action: r.tool ? humanize(r.tool) : r.step ? humanize(r.step) : "Mission step",
    target: `Mission ${r.missionId}`,
    source: "mission_event",
    link: `/dashboard/missions/${enc(r.missionId)}`,
    summary: r.step && r.tool ? humanize(r.step) : null,
  };
}

export function fromMediaAuditEvent(r: { id: string; ts: Date; actor: string; action: string; subjectType: string; subjectId: string | null }): TimelineEntry {
  return {
    key: `media_audit_event:${r.id}`,
    at: iso(r.ts),
    actor: classifyActor(r.actor),
    action: humanize(r.action),
    target: r.subjectId ? `${humanize(r.subjectType)} ${r.subjectId}` : humanize(r.subjectType),
    source: "media_audit_event",
    link: "/dashboard/settings/media",
    summary: null,
  };
}

export function fromAuthorityAuditEvent(r: { id: string; ts: Date; actor: string; action: string; entityType: string; entityId: string }): TimelineEntry {
  return {
    key: `authority_audit_event:${r.id}`,
    at: iso(r.ts),
    actor: classifyActor(r.actor),
    action: humanize(r.action),
    target: `${humanize(r.entityType)} ${r.entityId}`,
    source: "authority_audit_event",
    link: "/dashboard/authority",
    summary: null,
  };
}

export function fromFlywheelAuditEvent(r: { id: string; ts: Date; actor: string; kind: string; correlationId: string }): TimelineEntry {
  return {
    key: `flywheel_audit_event:${r.id}`,
    at: iso(r.ts),
    actor: classifyActor(r.actor),
    action: humanize(r.kind),
    target: r.correlationId,
    source: "flywheel_audit_event",
    link: "/dashboard/flywheel",
    summary: null,
  };
}

export function fromEsignAuditEvent(r: { id: string; createdAt: Date; actor: string; event: string; envelope: { id: string; title: string | null } | null }): TimelineEntry {
  return {
    key: `esign_audit_event:${r.id}`,
    at: iso(r.createdAt),
    actor: classifyActor(r.actor),
    action: humanize(r.event),
    target: r.envelope?.title ?? null,
    source: "esign_audit_event",
    link: r.envelope ? `/dashboard/esign?envelope=${enc(r.envelope.id)}` : "/dashboard/esign",
    summary: null,
  };
}

// ---------------------------------------------------------------------------
// Ordering, paging, filtering, CSV
// ---------------------------------------------------------------------------

/** Newest first; ties broken by key (descending) so paging is total. PURE. */
export function compareEntries(a: Pick<TimelineEntry, "at" | "key">, b: Pick<TimelineEntry, "at" | "key">): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

export interface Cursor {
  at: string;
  key: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.at}|${c.key}`, "utf8").toString("base64url");
}

export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s) return null;
  try {
    const raw = Buffer.from(s, "base64url").toString("utf8");
    const i = raw.indexOf("|");
    if (i <= 0) return null;
    const at = raw.slice(0, i);
    const key = raw.slice(i + 1);
    if (Number.isNaN(new Date(at).getTime()) || !key) return null;
    return { at: new Date(at).toISOString(), key };
  } catch {
    return null;
  }
}

/** Strictly after the cursor in timeline order (older, or same time and lower key). PURE. */
export function isAfterCursor(e: Pick<TimelineEntry, "at" | "key">, c: Cursor | null): boolean {
  if (!c) return true;
  return compareEntries(e, c) > 0;
}

export interface TimelineFilter {
  actorKind?: ActorKind | null;
  sources?: readonly TimelineSource[] | null;
  from?: Date | null;
  to?: Date | null;
  /** Only rows by this person (the data access log's "for me"). */
  actorId?: string | null;
}

export function matchesFilter(e: TimelineEntry, f: TimelineFilter): boolean {
  if (f.actorKind && e.actor.kind !== f.actorKind) return false;
  if (f.sources?.length && !f.sources.includes(e.source)) return false;
  if (f.from && e.at < f.from.toISOString()) return false;
  if (f.to && e.at > f.to.toISOString()) return false;
  return true;
}

/**
 * Merge per-source pages (each already newest-first) into one page of
 * `limit` entries after the cursor, plus the next cursor. PURE.
 */
export function mergePages(pages: readonly (readonly TimelineEntry[])[], cursor: Cursor | null, limit: number, filter: TimelineFilter = {}): { entries: TimelineEntry[]; next: string | null } {
  const all = pages.flat().filter((e) => isAfterCursor(e, cursor) && matchesFilter(e, filter));
  all.sort(compareEntries);
  const entries = all.slice(0, limit);
  const last = entries[entries.length - 1];
  return { entries, next: all.length > limit && last ? encodeCursor({ at: last.at, key: last.key }) : null };
}

/** Formula-neutralised, always-quoted CSV cell (same rule as lib/csv.ts). */
function cell(v: string | null): string {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const CSV_HEADER = "at,actor_kind,actor,action,target,source,summary,link";

export function csvRow(e: TimelineEntry): string {
  return [e.at, e.actor.kind, e.actor.label, e.action, e.target, e.source, e.summary, e.link].map((v) => cell(v)).join(",");
}

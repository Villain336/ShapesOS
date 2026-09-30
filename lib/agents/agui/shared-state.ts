// Marketr — Phase 16 slice 4: CoAgents shared state (pure domain).
//
// The three shared-state domains, their sources of truth, and the pure
// mappers/diff/merge that move them between the agent backend and the
// CopilotKit v2 frontend (`useAgent` from `@copilotkit/react-core/v2`,
// installed @copilotkit/react-core@1.75.0).
//
// Sources of truth (never duplicated — this module only mirrors them):
//   calendar  → SocialPost rows (prisma/social_posts), the social content
//               calendar in app/dashboard/social/SocialApp.tsx; the Univer
//               sheet (sourceRef "social:calendar") is a derived export.
//   mission   → Mission + MissionEvent rows (prisma/missions, mission_events);
//               MissionEvent is append-only, so mission state is read-only here.
//   approvals → AutopilotItem rows (prisma/autopilot_items) via the Phase 14
//               gate (lib/seo/autopilot-service.ts); the gate stays
//               authoritative — approve/deny/edit still go through the gate
//               routes, never through state writes.
//   operations → Operations summary (Phase 17: lib/ops/summary.ts) — counts
//               of open invoices, overdue invoices, low-stock products, and
//               pending ops approvals. READ-ONLY: all ops writes go through
//               the ops services/routes behind the Phase 14 gate, never
//               through state writes.
//
// This module is intentionally pure: no prisma, no LLM, no DOM. Safe for
// node:test. DB access lives in ./shared-state-db.ts; the AG-UI wire-up
// (STATE_SNAPSHOT/DELTA emission) lives in ./adapter.ts.

import type { JsonPatch } from "./events";

// ---------------------------------------------------------------------------
// State shapes (what travels in AG-UI STATE_SNAPSHOT / agent.state)
// ---------------------------------------------------------------------------

/** One content-calendar row, mirrored from a SocialPost. */
export interface CalendarRow {
  id: string;
  /** ISO datetime or null (unscheduled draft). */
  scheduledFor: string | null;
  /** Plain-text excerpt of the post content. */
  text: string;
  /** Target services, e.g. ["twitter", "linkedin"]. */
  channels: string[];
  status: string;
  updatedAt: string;
}

export interface ContentCalendarState {
  rows: CalendarRow[];
  updatedAt: string;
}

export interface MissionCheckpoint {
  label: string;
  done: boolean;
  at: string | null;
}

export interface MissionSharedState {
  id: string;
  template: string;
  /** Human-readable goal summary. */
  goal: string;
  status: string;
  /** 0..1 */
  progress: number;
  checkpoints: MissionCheckpoint[];
  lastEvent: { step: string | null; tool: string | null; at: string } | null;
  updatedAt: string;
}

export interface ApprovalQueueItem {
  id: string;
  kind: string;
  title: string;
  status: string;
  ruleId: string;
  updatedAt: string;
}

export interface ApprovalQueueState {
  pendingCount: number;
  items: ApprovalQueueItem[];
  updatedAt: string;
}

/**
 * Operations pulse (Phase 17): read-only mirror of lib/ops/summary.ts.
 * Written only by the backend loader; never by the UI.
 */
export interface OperationsState {
  openInvoices: number;
  overdueInvoices: number;
  lowStockCount: number;
  pendingOpsApprovals: number;
  updatedAt: string;
}

/** The full agent↔UI shared state (keys are the CoAgents state domains). */
export interface SharedAgentState {
  calendar?: ContentCalendarState;
  mission?: MissionSharedState | null;
  approvals?: ApprovalQueueState;
  operations?: OperationsState;
}

// ---------------------------------------------------------------------------
// Lite source-of-truth shapes (mappers take these, not Prisma types,
// so tests never need a DB)
// ---------------------------------------------------------------------------

export interface SocialPostLite {
  id: string;
  content: unknown;
  services: string[];
  scheduledFor: string | Date | null;
  status: string;
  updatedAt: string | Date;
}

export interface MissionLite {
  id: string;
  template: string;
  goal: unknown;
  status: string;
  checkpoints: unknown;
  updatedAt: string | Date;
}

export interface MissionEventLite {
  step: string | null;
  tool: string | null;
  ts: string | Date;
}

export interface AutopilotItemLite {
  id: string;
  kind: string;
  title: string;
  status: string;
  ruleId: string;
  updatedAt: string | Date;
}

/** Lite shape of the ops summary (lib/ops/summary.ts OpsSummary) for the mapper. */
export interface OpsSummaryLite {
  openInvoices: number;
  overdueInvoices: number;
  lowStockCount: number;
  pendingOpsApprovals: number;
}

// ---------------------------------------------------------------------------
// Mappers: source of truth → shared state
// ---------------------------------------------------------------------------

function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function isoNow(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

/** SocialPost.content is SocialContent JSON ({ text, per-channel overrides, … }). */
export function postTextExcerpt(content: unknown, maxLen = 140): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") text = c.text;
    else if (typeof c.caption === "string") text = c.caption;
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

/** SocialPost rows → calendar state (scheduled-first, drafts last). */
export function mapPostsToCalendar(posts: SocialPostLite[]): ContentCalendarState {
  const rows: CalendarRow[] = posts.map((p) => ({
    id: p.id,
    scheduledFor: iso(p.scheduledFor),
    text: postTextExcerpt(p.content),
    channels: Array.isArray(p.services) ? p.services.filter((s) => typeof s === "string") : [],
    status: String(p.status),
    updatedAt: isoNow(p.updatedAt),
  }));
  rows.sort((a, b) => {
    if (a.scheduledFor === b.scheduledFor) return 0;
    if (a.scheduledFor === null) return 1;
    if (b.scheduledFor === null) return -1;
    return a.scheduledFor < b.scheduledFor ? -1 : 1;
  });
  const newest = rows.reduce<string | null>(
    (acc, r) => (acc === null || r.updatedAt > acc ? r.updatedAt : acc),
    null,
  );
  return { rows, updatedAt: newest ?? new Date(0).toISOString() };
}

/** Mission.goal Json → one-line human summary. */
export function missionGoalSummary(goal: unknown, maxLen = 160): string {
  if (typeof goal === "string") {
    const t = goal.replace(/\s+/g, " ").trim();
    return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
  }
  if (goal && typeof goal === "object") {
    const g = goal as Record<string, unknown>;
    for (const key of ["objective", "summary", "title", "description"]) {
      if (typeof g[key] === "string" && (g[key] as string).trim()) {
        return missionGoalSummary(g[key], maxLen);
      }
    }
    try {
      const s = JSON.stringify(goal);
      return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
    } catch {
      return "Mission";
    }
  }
  return "Mission";
}

function checkpointList(checkpoints: unknown): MissionCheckpoint[] {
  if (!Array.isArray(checkpoints)) return [];
  return checkpoints
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const r = c as Record<string, unknown>;
      const label =
        typeof r.reason === "string" && r.reason
          ? r.reason
          : typeof r.label === "string" && r.label
            ? r.label
            : "checkpoint";
      const at = r.at;
      return {
        label,
        done: true, // a recorded checkpoint is a completed one
        at: typeof at === "string" ? at : at instanceof Date ? at.toISOString() : null,
      };
    });
}

/**
 * Mission (+ recent events) → mission state.
 * progress: fraction of recorded checkpoints over (checkpoints + 1 pending
 * leg) when there is at least one checkpoint, else 0 for planned / 1 for
 * complete|archived. MissionEvent is append-only → this is read-only state.
 */
export function mapMissionToState(
  mission: MissionLite,
  events: MissionEventLite[],
): MissionSharedState {
  const checkpoints = checkpointList(mission.checkpoints);
  const status = String(mission.status);
  let progress: number;
  if (status === "complete" || status === "archived") progress = 1;
  else if (checkpoints.length > 0) progress = checkpoints.length / (checkpoints.length + 1);
  else progress = 0;

  const sorted = [...events].sort((a, b) => {
    const ta = a.ts instanceof Date ? a.ts.getTime() : Date.parse(String(a.ts));
    const tb = b.ts instanceof Date ? b.ts.getTime() : Date.parse(String(b.ts));
    return tb - ta;
  });
  const latest = sorted[0] ?? null;

  return {
    id: mission.id,
    template: String(mission.template),
    goal: missionGoalSummary(mission.goal),
    status,
    progress: Math.min(1, Math.max(0, progress)),
    checkpoints,
    lastEvent: latest
      ? {
          step: latest.step,
          tool: latest.tool,
          at: latest.ts instanceof Date ? latest.ts.toISOString() : String(latest.ts),
        }
      : null,
    updatedAt: isoNow(mission.updatedAt),
  };
}

/** Pending-first AutopilotItem rows → approval queue state (gate is the law). */
export function mapItemsToApprovals(items: AutopilotItemLite[]): ApprovalQueueState {
  const mapped: ApprovalQueueItem[] = items.map((i) => ({
    id: i.id,
    kind: String(i.kind),
    title: String(i.title),
    status: String(i.status),
    ruleId: String(i.ruleId),
    updatedAt: isoNow(i.updatedAt),
  }));
  const pendingCount = mapped.filter((i) => i.status === "pending").length;
  // Pending first, then most recently updated.
  mapped.sort((a, b) => {
    const ap = a.status === "pending" ? 0 : 1;
    const bp = b.status === "pending" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
  const newest = mapped.reduce<string | null>(
    (acc, i) => (acc === null || i.updatedAt > acc ? i.updatedAt : acc),
    null,
  );
  return { pendingCount, items: mapped, updatedAt: newest ?? new Date(0).toISOString() };
}

/** Ops summary → operations shared state (read-only mirror). */
export function mapOpsSummaryToState(s: OpsSummaryLite): OperationsState {
  return {
    openInvoices: s.openInvoices,
    overdueInvoices: s.overdueInvoices,
    lowStockCount: s.lowStockCount,
    pendingOpsApprovals: s.pendingOpsApprovals,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Diff: shared state → JSON patch (for STATE_DELTA)
// ---------------------------------------------------------------------------

function stable(v: unknown): string {
  return JSON.stringify(v ?? null);
}

/**
 * Domain-level JSON patch (RFC 6902): one `replace` per changed domain.
 * Domains are small (bounded row counts); whole-domain replace keeps the
 * patch trivially valid against the snapshot shape.
 */
export function diffSharedState(prev: SharedAgentState, next: SharedAgentState): JsonPatch {
  const patch: JsonPatch = [];
  (["calendar", "mission", "approvals", "operations"] as const).forEach((domain) => {
    if (stable(prev[domain]) !== stable(next[domain])) {
      patch.push({ op: "replace", path: `/${domain}`, value: next[domain] ?? null });
    }
  });
  return patch;
}

// ---------------------------------------------------------------------------
// Merge / edit helpers (used by the adapter and the frontend hook)
// ---------------------------------------------------------------------------

const EMPTY_STATE: SharedAgentState = {};

/** Overlay wins per-domain; domains absent from the overlay keep the base. */
export function mergeSharedState(
  base: SharedAgentState | null | undefined,
  overlay: SharedAgentState | null | undefined,
): SharedAgentState {
  const b = base ?? EMPTY_STATE;
  const o = overlay ?? EMPTY_STATE;
  return {
    ...(b.calendar !== undefined || o.calendar !== undefined
      ? { calendar: o.calendar !== undefined ? o.calendar : b.calendar }
      : {}),
    ...(b.mission !== undefined || o.mission !== undefined
      ? { mission: o.mission !== undefined ? o.mission : b.mission }
      : {}),
    ...(b.approvals !== undefined || o.approvals !== undefined
      ? { approvals: o.approvals !== undefined ? o.approvals : b.approvals }
      : {}),
    ...(b.operations !== undefined || o.operations !== undefined
      ? { operations: o.operations !== undefined ? o.operations : b.operations }
      : {}),
  };
}

export interface CalendarRowPatch {
  scheduledFor?: string | null;
  status?: string;
}

/**
 * Apply a UI edit to one calendar row (pure). Returns a new state object.
 * The actual DB write happens server-side in shared-state-db.ts; the
 * frontend applies this locally first via agent.setState (optimistic),
 * then the backend re-emits the canonical snapshot.
 */
export function updateCalendarRowInState(
  state: SharedAgentState,
  rowId: string,
  patch: CalendarRowPatch,
): SharedAgentState {
  const rows = state.calendar?.rows ?? [];
  const now = new Date().toISOString();
  const nextRows = rows.map((r) =>
    r.id === rowId
      ? {
          ...r,
          ...(patch.scheduledFor !== undefined ? { scheduledFor: patch.scheduledFor } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          updatedAt: now,
        }
      : r,
  );
  return mergeSharedState(state, {
    calendar: { rows: nextRows, updatedAt: now },
  });
}

/** Calendar rows whose scheduledFor/status differ between two snapshots. */
export function changedCalendarRows(
  prev: SharedAgentState,
  next: SharedAgentState,
): Array<{ id: string; scheduledFor?: string | null; status?: string }> {
  const prevById = new Map((prev.calendar?.rows ?? []).map((r) => [r.id, r]));
  const out: Array<{ id: string; scheduledFor?: string | null; status?: string }> = [];
  for (const row of next.calendar?.rows ?? []) {
    const p = prevById.get(row.id);
    if (!p) continue; // new rows are agent-created; the DB is authoritative
    const change: { id: string; scheduledFor?: string | null; status?: string } = { id: row.id };
    if (p.scheduledFor !== row.scheduledFor) change.scheduledFor = row.scheduledFor;
    if (p.status !== row.status) change.status = row.status;
    if (change.scheduledFor !== undefined || change.status !== undefined) out.push(change);
  }
  return out;
}

/** Result of applying one UI-originated calendar change (shared-state-db). */
export interface AppliedStateChange {
  domain: "calendar";
  id: string;
  scheduledFor?: string | null;
  status?: string;
  /** Set when the change was refused (bad date, disallowed status, unknown row). */
  skipped?: string;
}

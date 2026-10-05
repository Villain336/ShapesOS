// ShapesOS — Agentic OS status language (pure; no React, no DOM, no prisma).
//
// The four status colors mean exactly one agent/run state each and always
// travel with their shape and a text label (docs/design/DESIGN.md). Queued and
// Paused are ink-only. Every component in components/aos/ and every page that
// shows an agent or run state maps through here, so "running" can never be
// drawn with the wrong color, shape or word.

export type AosStatus = "running" | "needs" | "done" | "failed" | "queued" | "paused";
/** The four states that carry a status color. */
export type AosColorStatus = Extract<AosStatus, "running" | "needs" | "done" | "failed">;

export const AOS_STATUSES: readonly AosStatus[] = ["running", "needs", "done", "failed", "queued", "paused"];
export const AOS_COLOR_STATUSES: readonly AosColorStatus[] = ["running", "needs", "done", "failed"];

export interface StatusMeta {
  /** Badge / screen-reader label (sentence case). */
  label: string;
  /** Longer explanation (foundation tiles, tooltips). */
  description: string;
  /** Shape drawn for the state. */
  shape: "circle" | "triangle" | "quarter" | "square" | "ring" | "bars";
  /** Tailwind fill class for filled surfaces (badges, bands, banners). */
  fill: string;
  /** Text/mark color class on that fill. */
  onFill: string;
  /** Shape color as a CSS value on paper/canvas. */
  mark: string;
  /** Shape color as a CSS value on night surfaces (sidebar, toasts). */
  markNight: string;
  /** Whether the shape pulses while live. */
  live: boolean;
}

export const STATUS_META: Readonly<Record<AosStatus, StatusMeta>> = Object.freeze({
  running: {
    label: "Running",
    description: "An agent is working on it",
    shape: "circle",
    fill: "bg-running",
    onFill: "text-paper",
    mark: "var(--aos-running)",
    markNight: "var(--aos-running-on-night)",
    live: true,
  },
  needs: {
    label: "Needs you",
    description: "Waiting on your approval or input",
    shape: "triangle",
    fill: "bg-needs",
    onFill: "text-ink",
    mark: "var(--aos-needs)",
    markNight: "var(--aos-needs)",
    live: false,
  },
  done: {
    label: "Done",
    description: "Finished and ready to review",
    shape: "quarter",
    fill: "bg-done",
    onFill: "text-paper",
    mark: "var(--aos-done)",
    markNight: "var(--aos-done-on-night)",
    live: false,
  },
  failed: {
    label: "Failed",
    description: "Stopped on an error you can fix",
    shape: "square",
    fill: "bg-failed",
    onFill: "text-paper",
    mark: "var(--aos-failed)",
    markNight: "var(--aos-failed-on-night)",
    live: false,
  },
  queued: {
    label: "Queued",
    description: "Waiting for its turn",
    shape: "ring",
    fill: "bg-paper",
    onFill: "text-ink",
    mark: "var(--aos-ink)",
    markNight: "var(--aos-night-text-soft)",
    live: false,
  },
  paused: {
    label: "Paused",
    description: "Stopped until someone resumes it",
    shape: "bars",
    fill: "bg-line",
    onFill: "text-ink",
    mark: "var(--aos-ink)",
    markNight: "var(--aos-night-text-soft)",
    live: false,
  },
});

/**
 * SVG geometry on a 0 0 14 14 viewBox (DESIGN.md "Status shapes"). Filled
 * shapes use `d` as a fill; ring and bars are strokes.
 */
export const SHAPE_PATHS: Readonly<Record<AosStatus, { d: string; stroke?: number }>> = Object.freeze({
  running: { d: "M0 7a7 7 0 1 0 14 0a7 7 0 1 0-14 0z" },
  needs: { d: "M7 0.8 13.6 13.2H0.4z" },
  done: { d: "M1 13V1a12 12 0 0 1 12 12z" },
  failed: { d: "M1 1h12v12H1z" },
  queued: { d: "M1.4 7a5.6 5.6 0 1 0 11.2 0a5.6 5.6 0 1 0-11.2 0z", stroke: 2.4 },
  paused: { d: "M4 1.5v11M10 1.5v11", stroke: 2.8 },
});

export function statusLabel(status: AosStatus): string {
  return STATUS_META[status].label;
}

export function isAosStatus(v: unknown): v is AosStatus {
  return typeof v === "string" && (AOS_STATUSES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Mapping real records to a status. Null = no agent state to show (e.g. a
// cancelled run): render it neutral, never with a status color.
// ---------------------------------------------------------------------------

/** AgentRun.status (prisma AgentRunStatus). */
export function fromAgentRunStatus(s: string): AosStatus | null {
  switch (s) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return null; // cancelled
  }
}

/** SkillRun.status (prisma SkillRunStatus). */
export function fromSkillRunStatus(s: string): AosStatus | null {
  switch (s) {
    case "pending":
    case "approved":
      return "queued";
    case "awaiting_approval":
      return "needs";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return null; // rejected, cancelled
  }
}

/** Mission.status, raised to "needs" while an approval is waiting on a human. */
export function fromMissionStatus(s: string, pendingApprovals = 0): AosStatus | null {
  if (pendingApprovals > 0 && (s === "active" || s === "paused" || s === "planned")) return "needs";
  switch (s) {
    case "planned":
      return "queued";
    case "active":
      return "running";
    case "paused":
      return "paused";
    case "complete":
      return "done";
    default:
      return null; // archived
  }
}

/**
 * Which state wins when several roll up into one (a lead agent over its
 * branches, a banner over many runs): what needs the human first, then what
 * broke, then live work.
 */
const PRIORITY: Readonly<Record<AosStatus, number>> = { needs: 0, failed: 1, running: 2, queued: 3, paused: 4, done: 5 };

export function statusPriority(s: AosStatus): number {
  return PRIORITY[s];
}

export function rollupStatus(statuses: readonly (AosStatus | null | undefined)[]): AosStatus | null {
  let best: AosStatus | null = null;
  for (const s of statuses) {
    if (!s) continue;
    if (best === null || PRIORITY[s] < PRIORITY[best]) best = s;
  }
  return best;
}

export type StatusCounts = Record<AosColorStatus, number>;

/** Counts of the four colored states (LiveActivity pill, sidebar). */
export function countStatuses(statuses: readonly (AosStatus | null | undefined)[]): StatusCounts {
  const out: StatusCounts = { running: 0, needs: 0, done: 0, failed: 0 };
  for (const s of statuses) {
    if (s === "running" || s === "needs" || s === "done" || s === "failed") out[s] += 1;
  }
  return out;
}

/** Sort comparator: status priority, then newest first. */
export function byStatusThenRecent<T extends { status: AosStatus; updatedAt: string }>(a: T, b: T): number {
  const p = PRIORITY[a.status] - PRIORITY[b.status];
  if (p !== 0) return p;
  return b.updatedAt.localeCompare(a.updatedAt);
}

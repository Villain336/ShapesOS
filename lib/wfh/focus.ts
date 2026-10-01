// Marketr — Wave 2 WFH mode slice 3: focus-block domain rules (calendar-lite).
//
// FocusBlock is a protected deep-work block. Conflict detection runs against
// a CalendarAdapter — today that is the manual/local event list (the
// Microsoft Graph / Google Toolbox integration wave was parked, so live
// calendar OAuth is a stub connection row, not a working rail).
//
// Protection levels:
//   soft — decline-with-suggestion: the OS proposes alternative times for
//          conflicting events; nothing is declined automatically.
//   hard — auto-decline: the OS may decline meetings on the user's behalf.
//          Requires a connected calendar AND the one-time auto-decline consent
//          gate. Without either, enforcement fails closed with NO_CALENDAR /
//          CONSENT_REQUIRED — never silently declines.

export type FocusProtection = "soft" | "hard";
export type FocusSource = "user" | "os_suggested" | "ritual";
export type FocusStatus = "scheduled" | "protected" | "overridden" | "completed" | "cancelled";
export type FocusRecurrence = "none" | "daily" | "weekdays" | "weekly";

export const FOCUS_STATUSES: FocusStatus[] = [
  "scheduled",
  "protected",
  "overridden",
  "completed",
  "cancelled",
];

export interface CalendarEventLike {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
}

/** Read-only calendar surface. Live OAuth adapters plug in here later. */
export interface CalendarAdapter {
  readonly provider: string;
  listEvents(start: Date, end: Date): Promise<CalendarEventLike[]>;
}

export interface FocusBlockInput {
  title?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  recurrence?: unknown;
  protection?: unknown;
  source?: unknown;
}

export interface NormalizedFocusBlock {
  title: string;
  startAt: Date;
  endAt: Date;
  recurrence: FocusRecurrence;
  protection: FocusProtection;
  source: FocusSource;
}

export class WfhFocusError extends Error {
  readonly code:
    | "VALIDATION_FAILED"
    | "NO_CALENDAR"
    | "CONSENT_REQUIRED"
    | "INVALID_TRANSITION";
  readonly details: string[];
  constructor(code: WfhFocusError["code"], message: string, details: string[] = []) {
    super(message);
    this.name = "WfhFocusError";
    this.code = code;
    this.details = details;
  }
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Validate + normalize a focus-block create/update payload. Pure. */
export function validateFocusBlock(input: FocusBlockInput): {
  ok: boolean;
  errors: string[];
  normalized: NormalizedFocusBlock | null;
} {
  const errors: string[] = [];
  const title = String(input.title ?? "").trim();
  if (!title) errors.push("Give the focus block a title (e.g. “Deep work — Q3 plan”).");
  if (title.length > 120) errors.push("Title must be 120 characters or fewer.");

  const startAt = toDate(input.startAt);
  const endAt = toDate(input.endAt);
  if (!startAt) errors.push("startAt must be a valid date-time.");
  if (!endAt) errors.push("endAt must be a valid date-time.");
  if (startAt && endAt && endAt <= startAt) {
    errors.push("The block must end after it starts.");
  }
  if (startAt && endAt && endAt.getTime() - startAt.getTime() > 12 * 3600 * 1000) {
    errors.push("A single focus block may not exceed 12 hours.");
  }

  const recurrence = String(input.recurrence ?? "none").toLowerCase();
  const validRec: FocusRecurrence[] = ["none", "daily", "weekdays", "weekly"];
  if (!validRec.includes(recurrence as FocusRecurrence)) {
    errors.push("Recurrence must be one of: none, daily, weekdays, weekly.");
  }
  const protection = String(input.protection ?? "soft").toLowerCase();
  if (protection !== "soft" && protection !== "hard") {
    errors.push("Protection must be 'soft' or 'hard'.");
  }
  const source = String(input.source ?? "user").toLowerCase();
  const validSrc: FocusSource[] = ["user", "os_suggested", "ritual"];
  if (!validSrc.includes(source as FocusSource)) {
    errors.push("Source must be one of: user, os_suggested, ritual.");
  }

  if (errors.length > 0) return { ok: false, errors, normalized: null };
  return {
    ok: true,
    errors: [],
    normalized: {
      title,
      startAt: startAt as Date,
      endAt: endAt as Date,
      recurrence: recurrence as FocusRecurrence,
      protection: protection as FocusProtection,
      source: source as FocusSource,
    },
  };
}

export interface Conflict {
  eventId: string;
  title: string;
  overlapMin: number;
}

/** Find events overlapping the block. Pure. */
export function findConflicts(
  block: { startAt: Date; endAt: Date },
  events: CalendarEventLike[],
): Conflict[] {
  const out: Conflict[] = [];
  for (const e of events) {
    const overlapMs =
      Math.min(block.endAt.getTime(), e.endAt.getTime()) -
      Math.max(block.startAt.getTime(), e.startAt.getTime());
    if (overlapMs > 0) {
      out.push({
        eventId: e.id,
        title: e.title,
        overlapMin: Math.round(overlapMs / 60000),
      });
    }
  }
  return out.sort(
    (a, b) => a.overlapMin - b.overlapMin || a.title.localeCompare(b.title),
  );
}

export interface SuggestedReschedule {
  eventId: string;
  title: string;
  /** Proposed new start: the first free slot of matching length after the block. */
  suggestedStartAt: Date;
  suggestedEndAt: Date;
}

/**
 * Soft protection: for each conflicting event, suggest the earliest slot of
 * equal length after the block ends (15-min granularity, same day). Pure.
 */
export function suggestReschedules(
  block: { startAt: Date; endAt: Date },
  conflicts: Conflict[],
  events: CalendarEventLike[],
): SuggestedReschedule[] {
  const dayEnd = new Date(block.startAt);
  dayEnd.setHours(23, 59, 59, 999);
  return conflicts.map((c) => {
    const original = events.find((e) => e.id === c.eventId);
    const durationMs = original
      ? original.endAt.getTime() - original.startAt.getTime()
      : 30 * 60000;
    let candidate = new Date(Math.ceil(block.endAt.getTime() / 900000) * 900000);
    for (;;) {
      const candidateEnd = new Date(candidate.getTime() + durationMs);
      if (candidateEnd > dayEnd) break; // no room today: keep the post-block slot anyway
      const clash = events.some(
        (e) =>
          e.id !== c.eventId &&
          candidate < e.endAt &&
          candidateEnd > e.startAt,
      );
      if (!clash) break;
      candidate = new Date(candidate.getTime() + 15 * 60000);
      if (candidate > dayEnd) break;
    }
    return {
      eventId: c.eventId,
      title: c.title,
      suggestedStartAt: candidate,
      suggestedEndAt: new Date(candidate.getTime() + durationMs),
    };
  });
}

export interface CalendarConnectionState {
  provider: "google" | "microsoft";
  status: "connected" | "disconnected";
  autoDeclineConsentAt: Date | null;
}

export interface EnforcementResult {
  protection: FocusProtection;
  newStatus: FocusStatus;
  conflicts: Conflict[];
  suggestions: SuggestedReschedule[];
  autoDeclined: string[];
  note: string;
}

/**
 * Enforce a focus block. Soft: report conflicts + suggestions, mark protected.
 * Hard: requires a connected calendar AND the one-time auto-decline consent —
 * without either it fails closed (NO_CALENDAR / CONSENT_REQUIRED). With
 * consent but no live calendar rail, conflicting events are recorded as
 * pending_auto_decline — the actual decline call waits on the parked
 * calendar integration.
 */
export async function enforceFocusBlock(
  block: { id: string; startAt: Date; endAt: Date; protection: FocusProtection },
  adapter: CalendarAdapter | null,
  connection: CalendarConnectionState | null,
): Promise<EnforcementResult> {
  const events = adapter ? await adapter.listEvents(block.startAt, block.endAt) : [];
  const conflicts = findConflicts(block, events);

  if (block.protection === "soft") {
    return {
      protection: "soft",
      newStatus: "protected",
      conflicts,
      suggestions: suggestReschedules(block, conflicts, events),
      autoDeclined: [],
      note:
        conflicts.length === 0
          ? "No conflicts — the block is protected."
          : `${conflicts.length} conflict(s): suggestions prepared, nothing auto-declined (soft protection).`,
    };
  }

  // Hard protection: the consent gate.
  if (!connection || connection.status !== "connected" || !adapter) {
    throw new WfhFocusError(
      "NO_CALENDAR",
      "Hard protection needs a connected calendar. Connect Google or Microsoft Calendar first.",
    );
  }
  if (!connection.autoDeclineConsentAt) {
    throw new WfhFocusError(
      "CONSENT_REQUIRED",
      "Confirm once that the OS may decline meetings on your behalf during focus blocks.",
    );
  }
  return {
    protection: "hard",
    newStatus: "protected",
    conflicts,
    suggestions: [],
    autoDeclined: conflicts.map((c) => c.eventId),
    note:
      conflicts.length === 0
        ? "No conflicts — the block is protected."
        : `${conflicts.length} conflicting event(s) marked pending auto-decline (calendar rail pending — no live decline sent).`,
  };
}

/** Legal status transitions for a focus block. Pure. */
const TRANSITIONS: Record<FocusStatus, FocusStatus[]> = {
  scheduled: ["protected", "cancelled"],
  protected: ["overridden", "completed", "cancelled"],
  overridden: ["protected", "cancelled"],
  completed: [],
  cancelled: [],
};

export function transitionStatus(from: FocusStatus, to: FocusStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new WfhFocusError(
      "INVALID_TRANSITION",
      `Cannot move a focus block from ${from} to ${to}.`,
    );
  }
}

/**
 * Expand a recurring block into occurrences over the next `days` days.
 * Pure — the caller persists whichever occurrences it wants.
 */
export function expandRecurrence(
  block: { startAt: Date; endAt: Date; recurrence: FocusRecurrence },
  days: number,
): { startAt: Date; endAt: Date }[] {
  if (block.recurrence === "none" || days <= 0) {
    return [{ startAt: block.startAt, endAt: block.endAt }];
  }
  const out: { startAt: Date; endAt: Date }[] = [];
  const durationMs = block.endAt.getTime() - block.startAt.getTime();
  for (let d = 0; d < days; d++) {
    const day = new Date(block.startAt);
    day.setDate(day.getDate() + d);
    const dow = day.getDay();
    if (block.recurrence === "weekdays" && (dow === 0 || dow === 6)) continue;
    if (block.recurrence === "weekly" && d % 7 !== 0) continue;
    out.push({ startAt: day, endAt: new Date(day.getTime() + durationMs) });
  }
  return out;
}

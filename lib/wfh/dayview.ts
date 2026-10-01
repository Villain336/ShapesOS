// Marketr — Wave 2 WFH mode slice 7 (SPEC-WFH-MODE.md): WFH day view.
//
// The Sunsama-pattern daily planning page: today's focus blocks (recurring
// occurrences expanded), standup state, rituals due, and digest windows — one
// screen that answers "what does my WFH day look like?"
//
// Plus the 13B learning-loop hooks: the module emits structured learning
// signals (focus overridden, standup submitted, ritual joined/skipped) into
// WfhLearningSignal. Signals are facts about behavior, never judgments — the
// 13B loop consumes them to learn preferences (e.g. "this user always
// overrides Friday focus blocks" → suggest shorter Friday blocks).

export interface DayFocusOccurrence {
  blockId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  protection: string;
  status: string;
  recurrence: string;
}

export interface DayViewInput {
  now: Date;
  focusBlocks: {
    id: string;
    title: string;
    startAt: Date;
    endAt: Date;
    recurrence: "none" | "daily" | "weekdays" | "weekly";
    protection: string;
    status: string;
  }[];
  standup: { due: boolean; late: boolean; copy: string | null; submitted: boolean };
  ritualsDue: { ritualId: string; type: string; title: string; prompt: string | null; nextOccurrence: Date }[];
  digestWindows: { time: string; label: string; queued: number }[];
  mode: string;
}

export interface DayTimelineItem {
  kind: "focus" | "standup" | "ritual" | "digest";
  startAt: Date;
  endAt: Date | null;
  title: string;
  detail: string | null;
  status: string;
}

export interface DayView {
  date: string; // YYYY-MM-DD (UTC)
  mode: string;
  timeline: DayTimelineItem[];
  standup: DayViewInput["standup"];
  focusCount: number;
  protectedMinutes: number;
}

// Expand recurring blocks into today's occurrences and build the timeline.
export function buildDayView(input: DayViewInput): DayView {
  const now = input.now;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  const items: DayTimelineItem[] = [];
  let protectedMinutes = 0;

  for (const b of input.focusBlocks) {
    if (b.status === "cancelled") continue;
    for (const occ of occurrencesOnDay(b, dayStart, dayEnd)) {
      items.push({
        kind: "focus",
        startAt: occ.startAt,
        endAt: occ.endAt,
        title: b.title,
        detail: `${b.protection} protection${b.recurrence !== "none" ? ` · ${b.recurrence}` : ""}`,
        status: b.status,
      });
      protectedMinutes += Math.round((occ.endAt.getTime() - occ.startAt.getTime()) / 60000);
    }
  }

  if (input.standup.due || input.standup.submitted) {
    items.push({
      kind: "standup",
      startAt: new Date(dayStart.getTime() + 9 * 3600 * 1000),
      endAt: null,
      title: "Async standup",
      detail: input.standup.submitted ? "Submitted" : (input.standup.copy ?? "Due today"),
      status: input.standup.submitted ? "done" : input.standup.late ? "late" : "due",
    });
  }

  for (const r of input.ritualsDue) {
    items.push({
      kind: "ritual",
      startAt: r.nextOccurrence,
      endAt: null,
      title: r.title,
      detail: r.prompt,
      status: "due",
    });
  }

  for (const d of input.digestWindows) {
    const [h, m] = d.time.split(":").map(Number);
    items.push({
      kind: "digest",
      startAt: new Date(dayStart.getTime() + (h * 60 + m) * 60000),
      endAt: null,
      title: `Notification digest — ${d.label}`,
      detail: d.queued > 0 ? `${d.queued} item(s) queued` : "Nothing queued",
      status: d.queued > 0 ? "ready" : "empty",
    });
  }

  items.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  return {
    date: dayStart.toISOString().slice(0, 10),
    mode: input.mode,
    timeline: items,
    standup: input.standup,
    focusCount: items.filter((i) => i.kind === "focus").length,
    protectedMinutes,
  };
}

function occurrencesOnDay(
  b: DayViewInput["focusBlocks"][number],
  dayStart: Date,
  dayEnd: Date,
): { startAt: Date; endAt: Date }[] {
  const durMs = b.endAt.getTime() - b.startAt.getTime();
  const out: { startAt: Date; endAt: Date }[] = [];

  if (b.recurrence === "none") {
    if (b.startAt >= dayStart && b.startAt < dayEnd) {
      out.push({ startAt: b.startAt, endAt: b.endAt });
    }
    return out;
  }

  // Walk the recurrence from the block's start date to today.
  const stepDays = b.recurrence === "weekly" ? 7 : 1;
  const cursor = new Date(b.startAt);
  let guard = 0;
  while (cursor < dayEnd && guard < 400) {
    guard++;
    const isWeekday = cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6;
    const matches =
      b.recurrence === "daily" ||
      (b.recurrence === "weekdays" && isWeekday) ||
      (b.recurrence === "weekly" && cursor.getUTCDay() === b.startAt.getUTCDay());
    if (matches && cursor >= dayStart && cursor < dayEnd && cursor >= b.startAt) {
      out.push({ startAt: new Date(cursor), endAt: new Date(cursor.getTime() + durMs) });
    }
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
  }
  return out;
}

// ── 13B learning-loop signals ─────────────────────────────────────────────
// Signal types the WFH module emits. Each is a behavioral fact with enough
// context for the preference-learning loop to spot patterns.

export type LearningSignalType =
  | "focus_block_created"
  | "focus_block_overridden"
  | "focus_block_completed"
  | "standup_submitted"
  | "ritual_joined"
  | "ritual_retired"
  | "mode_enabled"
  | "mode_disabled";

export interface LearningSignal {
  type: LearningSignalType;
  source: "focus" | "standup" | "ritual" | "mode";
  occurredAt: Date;
  payload: Record<string, string | number | boolean | null>;
}

export function signalFocusCreated(block: {
  id: string;
  protection: string;
  recurrence: string;
  startAt: Date;
  endAt: Date;
}): LearningSignal {
  return {
    type: "focus_block_created",
    source: "focus",
    occurredAt: new Date(),
    payload: {
      blockId: block.id,
      protection: block.protection,
      recurrence: block.recurrence,
      startHour: block.startAt.getUTCHours(),
      durationMin: Math.round((block.endAt.getTime() - block.startAt.getTime()) / 60000),
      weekday: block.startAt.getUTCDay(),
    },
  };
}

export function signalFocusOverridden(block: {
  id: string;
  protection: string;
  conflicts: number;
}): LearningSignal {
  return {
    type: "focus_block_overridden",
    source: "focus",
    occurredAt: new Date(),
    payload: { blockId: block.id, protection: block.protection, conflicts: block.conflicts },
  };
}

export function signalStandupSubmitted(input: {
  standupId: string;
  late: boolean;
  visibility: string;
  hasBlockers: boolean;
  hasVideo: boolean;
}): LearningSignal {
  return {
    type: "standup_submitted",
    source: "standup",
    occurredAt: new Date(),
    payload: {
      standupId: input.standupId,
      late: input.late,
      visibility: input.visibility,
      hasBlockers: input.hasBlockers,
      hasVideo: input.hasVideo,
    },
  };
}

export function signalRitualJoined(input: {
  ritualId: string;
  ritualType: string;
  withNote: boolean;
}): LearningSignal {
  return {
    type: "ritual_joined",
    source: "ritual",
    occurredAt: new Date(),
    payload: { ritualId: input.ritualId, ritualType: input.ritualType, withNote: input.withNote },
  };
}

export function signalRitualRetired(input: { ritualId: string; ritualType: string; wasDead: boolean }): LearningSignal {
  return {
    type: "ritual_retired",
    source: "ritual",
    occurredAt: new Date(),
    payload: { ritualId: input.ritualId, ritualType: input.ritualType, wasDead: input.wasDead },
  };
}

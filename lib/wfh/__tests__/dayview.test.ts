// Marketr — Wave 2 WFH mode slice 7: day-view + learning-signal tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDayView,
  signalFocusCreated,
  signalFocusOverridden,
  signalStandupSubmitted,
  signalRitualJoined,
  signalRitualRetired,
} from "../dayview";

const THU = new Date("2026-10-01T14:00:00.000Z"); // Thursday

function block(over: Record<string, unknown> = {}) {
  return {
    id: "b1",
    title: "Deep work",
    startAt: new Date("2026-10-01T13:00:00.000Z"),
    endAt: new Date("2026-10-01T15:00:00.000Z"),
    recurrence: "none" as const,
    protection: "soft",
    status: "scheduled",
    ...over,
  };
}

describe("buildDayView", () => {
  it("places today's focus blocks on the timeline, sorted", () => {
    const v = buildDayView({
      now: THU,
      focusBlocks: [
        block(),
        block({ id: "b2", title: "Email", startAt: new Date("2026-10-01T08:00:00.000Z"), endAt: new Date("2026-10-01T08:30:00.000Z") }),
      ],
      standup: { due: false, late: false, copy: null, submitted: true },
      ritualsDue: [],
      digestWindows: [],
      mode: "wfh",
    });
    assert.equal(v.date, "2026-10-01");
    assert.equal(v.focusCount, 2);
    assert.equal(v.protectedMinutes, 150);
    assert.equal(v.timeline[0].title, "Email");
    assert.equal(v.timeline[1].title, "Async standup");
    assert.equal(v.timeline[2].title, "Deep work");
    // Standup submitted → appears on the timeline as done.
    assert.ok(v.timeline.some((t) => t.kind === "standup" && t.status === "done"));
  });

  it("expands a weekly recurring block onto today", () => {
    const v = buildDayView({
      now: THU,
      focusBlocks: [
        block({
          id: "bw",
          title: "Weekly planning",
          recurrence: "weekly",
          startAt: new Date("2026-09-24T13:00:00.000Z"), // previous Thursday
          endAt: new Date("2026-09-24T14:00:00.000Z"),
        }),
      ],
      standup: { due: false, late: false, copy: null, submitted: false },
      ritualsDue: [],
      digestWindows: [],
      mode: "wfh",
    });
    assert.equal(v.focusCount, 1);
    assert.equal(v.timeline[0].startAt.toISOString(), "2026-10-01T13:00:00.000Z");
  });

  it("skips cancelled blocks and includes digest windows", () => {
    const v = buildDayView({
      now: THU,
      focusBlocks: [block({ status: "cancelled" })],
      standup: { due: false, late: false, copy: null, submitted: false },
      ritualsDue: [],
      digestWindows: [{ time: "09:00", label: "Morning", queued: 3 }],
      mode: "wfh",
    });
    assert.equal(v.focusCount, 0);
    const digest = v.timeline.find((t) => t.kind === "digest");
    assert.equal(digest?.status, "ready");
    assert.match(digest?.detail ?? "", /3 item/);
  });

  it("lists rituals due on the timeline", () => {
    const v = buildDayView({
      now: THU,
      focusBlocks: [],
      standup: { due: true, late: false, copy: "Standup's due", submitted: false },
      ritualsDue: [
        {
          ritualId: "r1",
          type: "wins",
          title: "Wins",
          prompt: "What did you win?",
          nextOccurrence: new Date("2026-10-02T12:00:00.000Z"),
        },
      ],
      digestWindows: [],
      mode: "wfh",
    });
    assert.ok(v.timeline.some((t) => t.kind === "ritual" && t.title === "Wins"));
    assert.ok(v.timeline.some((t) => t.kind === "standup" && t.status === "due"));
  });
});

describe("learning signals", () => {
  it("builds well-shaped signals", () => {
    const s1 = signalFocusCreated({
      id: "b1",
      protection: "hard",
      recurrence: "weekdays",
      startAt: new Date("2026-10-01T13:00:00.000Z"),
      endAt: new Date("2026-10-01T15:00:00.000Z"),
    });
    assert.equal(s1.type, "focus_block_created");
    assert.equal(s1.payload.durationMin, 120);
    assert.equal(s1.payload.weekday, 4);

    const s2 = signalFocusOverridden({ id: "b1", protection: "soft", conflicts: 2 });
    assert.equal(s2.type, "focus_block_overridden");
    assert.equal(s2.payload.conflicts, 2);

    const s3 = signalStandupSubmitted({
      standupId: "s1",
      late: true,
      visibility: "team",
      hasBlockers: false,
      hasVideo: true,
    });
    assert.equal(s3.type, "standup_submitted");
    assert.equal(s3.payload.late, true);

    const s4 = signalRitualJoined({ ritualId: "r1", ritualType: "wins", withNote: true });
    assert.equal(s4.type, "ritual_joined");

    const s5 = signalRitualRetired({ ritualId: "r1", ritualType: "kudos", wasDead: true });
    assert.equal(s5.type, "ritual_retired");
    assert.equal(s5.payload.wasDead, true);
  });
});

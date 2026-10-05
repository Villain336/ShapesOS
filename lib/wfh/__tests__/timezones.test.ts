// ShapesOS — WFH local time: IANA timezone per user/ritual, calendar
// stepping across DST (FULL-AUDIT-2026-10-03 §5 "Time zones"; regression for
// the edge2/wfh1.ts probe). Every case here would pass or fail the same way
// whatever the server's own timezone is.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStandupDue, isStandupLate, standupDateFor, validateStandup } from "../standups";
import { dueWindowsFor, nextWindowMin, routeNotification } from "../notifications";
import { isWfhEffectiveOn, validateSetupInput } from "../mode";
import { nextOccurrence, occurrencesSince, validateRitual } from "../rituals";
import { expandRecurrence, suggestReschedules } from "../focus";
import { buildDayView } from "../dayview";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const iso = (d: Date) => d.toISOString();

describe("standups in the user's timezone", () => {
  it("weekdays cadence: Fri 19:00 in LA is still Friday (Saturday in UTC)", () => {
    const fri7pmPT = new Date("2026-10-10T02:00:00Z");
    assert.equal(isStandupDue("weekdays", fri7pmPT, false, LA), true);
    assert.equal(isStandupDue("weekdays", fri7pmPT, false, "UTC"), false);
  });

  it("late is judged on the local hour", () => {
    const at = new Date("2026-10-05T10:30:00Z"); // 03:30 PT
    assert.equal(isStandupLate(at, 10, LA), false);
    assert.equal(isStandupLate(at, 10, "UTC"), true);
  });

  it("the standup date is the local workday", () => {
    assert.equal(iso(standupDateFor(new Date("2026-10-10T02:00:00Z"), LA)), "2026-10-09T12:00:00.000Z");
    assert.equal(iso(standupDateFor(new Date("2026-10-10T02:00:00Z"), "UTC")), "2026-10-10T12:00:00.000Z");
  });

  it("validateStandup: plain dates are taken as-is and must exist; instants are read in the zone", () => {
    const base = { yesterday: "a", today: "b", visibility: "team" as const };
    assert.equal(iso(validateStandup({ ...base, date: "2026-10-01" }, LA).normalized!.date), "2026-10-01T12:00:00.000Z");
    assert.equal(validateStandup({ ...base, date: "2026-02-30" }, LA).ok, false);
    assert.equal(
      iso(validateStandup({ ...base, date: "2026-10-02T01:00:00Z" }, LA).normalized!.date),
      "2026-10-01T12:00:00.000Z",
    );
  });
});

describe("digest windows in the user's timezone", () => {
  it("a 09:00 window is not due at 05:00 New York time (09:00 UTC)", () => {
    assert.deepEqual(dueWindowsFor([540], new Date("2026-10-05T09:00:00Z"), {}, NY), []);
    assert.deepEqual(dueWindowsFor([540], new Date("2026-10-05T13:00:00Z"), {}, NY), [540]);
  });

  it("flushed-since-opening is judged against today's local window (fall-back day)", () => {
    // Sun 2026-11-01 (25-hour day): 09:00 EST = 14:00Z.
    const at = new Date("2026-11-01T15:00:00Z");
    assert.deepEqual(dueWindowsFor([540], at, { 540: "2026-11-01T14:05:00Z" }, NY), []);
    assert.deepEqual(dueWindowsFor([540], at, { 540: "2026-10-31T13:05:00Z" }, NY), [540]);
  });

  it("nextWindowMin uses local minutes; routing passes the user's zone through", () => {
    const at = new Date("2026-10-05T12:00:00Z"); // 08:00 EDT, 12:00 UTC
    assert.equal(nextWindowMin([540, 960], at, NY), 540);
    assert.equal(nextWindowMin([540, 960], at, "UTC"), 960);
  });

  it("routes a batched item to the user's local next window", () => {
    const d = routeNotification(
      { kind: "comment", title: "x" },
      {
        mode: { mode: "wfh", wfhDays: [], setupCompletedAt: new Date(), timezone: NY },
        notificationProfile: "batched",
        at: new Date("2026-10-05T15:00:00Z"), // 11:00 EDT
        digestTimesMin: [540, 960],
      },
    );
    assert.deepEqual(d, { deliver: "digest", reason: "batched_digest", windowMin: 960 });
  });
});

describe("hybrid days and setup", () => {
  it("hybrid WFH days follow the local weekday", () => {
    const state = { mode: "hybrid" as const, wfhDays: ["fri"], setupCompletedAt: new Date(), timezone: LA };
    assert.equal(isWfhEffectiveOn(state, new Date("2026-10-10T02:00:00Z")), true); // Fri evening PT
    assert.equal(isWfhEffectiveOn({ ...state, timezone: "UTC" }, new Date("2026-10-10T02:00:00Z")), false);
  });

  it("setup validates the timezone", () => {
    const ok = { wfhDays: ["mon"], focusStartMin: 540, focusEndMin: 1020 };
    assert.equal(validateSetupInput({ ...ok, timezone: NY }).normalized?.timezone, NY);
    assert.equal(validateSetupInput(ok).normalized?.timezone, null);
    assert.equal(validateSetupInput({ ...ok, timezone: "Mars/Base" }).ok, false);
  });
});

describe("rituals step by calendar", () => {
  it("weekly Monday 09:00 New York stays 09:00 across fall-back", () => {
    const anchor = new Date("2026-10-26T13:00:00Z"); // Mon 09:00 EDT
    const next = nextOccurrence(anchor, "weekly", new Date("2026-11-01T12:00:00Z"), NY);
    assert.equal(iso(next), "2026-11-02T14:00:00.000Z"); // Mon 09:00 EST
    // The old fixed-millisecond step landed on 08:00 EST.
    assert.notEqual(iso(next), "2026-11-02T13:00:00.000Z");
  });

  it("biweekly across spring-forward", () => {
    const anchor = new Date("2026-03-02T14:00:00Z"); // Mon 09:00 EST
    assert.equal(iso(nextOccurrence(anchor, "biweekly", new Date("2026-03-03T00:00:00Z"), NY)), "2026-03-16T13:00:00.000Z");
  });

  it("monthly = same day-of-month, clamped, never drifting", () => {
    const jan31 = new Date("2026-01-31T14:00:00Z"); // 09:00 EST
    const occ = occurrencesSince(jan31, "monthly", jan31, new Date("2026-05-01T00:00:00Z"), NY);
    assert.deepEqual(occ.map(iso), [
      "2026-01-31T14:00:00.000Z",
      "2026-02-28T14:00:00.000Z",
      "2026-03-31T13:00:00.000Z", // 09:00 EDT
      "2026-04-30T13:00:00.000Z",
    ]);
    // "Monthly" used to mean every 30 days (Feb 14, Mar 16, Apr 15 …).
    const jan15 = new Date("2026-01-15T14:00:00Z");
    assert.deepEqual(
      occurrencesSince(jan15, "monthly", new Date("2026-01-16T00:00:00Z"), new Date("2026-05-01T00:00:00Z"), NY).map(iso),
      ["2026-02-15T14:00:00.000Z", "2026-03-15T13:00:00.000Z", "2026-04-15T13:00:00.000Z"],
    );
  });

  it("monthly from a leap day: Mar 29, and Feb 28 in a non-leap year (never Mar 1)", () => {
    const leap = new Date("2028-02-29T12:00:00Z");
    assert.equal(iso(nextOccurrence(leap, "monthly", new Date("2029-02-01T00:00:00Z"))), "2029-02-28T12:00:00.000Z");
    assert.equal(iso(nextOccurrence(leap, "monthly", new Date("2028-03-01T00:00:00Z"))), "2028-03-29T12:00:00.000Z");
  });

  it("occurrences are unique and ascending across both DST changes", () => {
    const anchor = new Date("2026-01-05T06:30:00Z"); // daily 01:30 EST
    const occ = occurrencesSince(anchor, "daily", new Date("2026-01-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"), NY);
    assert.equal(new Set(occ.map(iso)).size, occ.length);
    for (let i = 1; i < occ.length; i++) assert.ok(occ[i] > occ[i - 1]);
    assert.equal(occ.length, 360);
  });

  it("validateRitual stores the zone and anchors on next Monday 12:00 local", () => {
    const v = validateRitual({ type: "wins", timezone: NY }, new Date("2026-10-01T12:00:00Z"));
    assert.equal(v.normalized?.timezone, NY);
    assert.equal(iso(v.normalized!.anchorDate), "2026-10-05T16:00:00.000Z");
    assert.equal(validateRitual({ type: "wins", timezone: "Nope/Nope" }).ok, false);
  });
});

describe("focus blocks in the user's timezone", () => {
  it("daily recurrence keeps 09:00 local across fall-back", () => {
    const occ = expandRecurrence(
      { startAt: new Date("2026-10-30T13:00:00Z"), endAt: new Date("2026-10-30T15:00:00Z"), recurrence: "daily" },
      5,
      NY,
    );
    assert.deepEqual(occ.map((o) => iso(o.startAt)), [
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
      "2026-11-03T14:00:00.000Z",
    ]);
    assert.ok(occ.every((o) => o.endAt.getTime() - o.startAt.getTime() === 2 * 3600e3));
  });

  it("weekdays skips the LOCAL weekend", () => {
    // Fri 18:00 PT = Sat 01:00 UTC — a weekday locally.
    const occ = expandRecurrence(
      { startAt: new Date("2026-10-10T01:00:00Z"), endAt: new Date("2026-10-10T02:00:00Z"), recurrence: "weekdays" },
      4,
      LA,
    );
    assert.equal(occ.length, 2); // Fri + Mon
  });

  it("reschedule suggestions stop at the end of the LOCAL day", () => {
    // Block 21:00–22:00 PT (04:00–05:00 UTC next day); 30-min event conflicts.
    const block = { startAt: new Date("2026-10-06T04:00:00Z"), endAt: new Date("2026-10-06T05:00:00Z") };
    const events = [{ id: "e", title: "Late call", startAt: new Date("2026-10-06T04:15:00Z"), endAt: new Date("2026-10-06T04:45:00Z") }];
    const s = suggestReschedules(block, [{ eventId: "e", title: "Late call", overlapMin: 30 }], events, LA);
    assert.equal(iso(s[0].suggestedStartAt), "2026-10-06T05:00:00.000Z"); // 22:00 PT, still today
  });
});

describe("day view in the user's timezone", () => {
  it("today, the standup slot and recurring blocks are local", () => {
    const v = buildDayView({
      now: new Date("2026-11-02T03:00:00Z"), // Sun 2026-11-01 22:00 EST
      focusBlocks: [
        {
          id: "d",
          title: "Daily deep work",
          startAt: new Date("2026-10-26T13:00:00Z"), // 09:00 EDT
          endAt: new Date("2026-10-26T14:00:00Z"),
          recurrence: "daily",
          protection: "soft",
          status: "scheduled",
        },
      ],
      standup: { due: true, late: true, copy: null, submitted: false },
      ritualsDue: [],
      digestWindows: [{ time: "16:00", label: "16:00", queued: 1 }],
      mode: "wfh",
      timeZone: NY,
    });
    assert.equal(v.date, "2026-11-01");
    const focus = v.timeline.find((t) => t.kind === "focus")!;
    assert.equal(iso(focus.startAt), "2026-11-01T14:00:00.000Z"); // 09:00 EST
    assert.equal(iso(v.timeline.find((t) => t.kind === "standup")!.startAt), "2026-11-01T14:00:00.000Z");
    assert.equal(iso(v.timeline.find((t) => t.kind === "digest")!.startAt), "2026-11-01T21:00:00.000Z");
  });
});

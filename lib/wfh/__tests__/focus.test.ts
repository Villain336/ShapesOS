// Marketr — Wave 2 WFH mode slice 3: focus-block domain tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFocusBlock,
  findConflicts,
  suggestReschedules,
  enforceFocusBlock,
  transitionStatus,
  expandRecurrence,
  WfhFocusError,
  type CalendarAdapter,
  type CalendarEventLike,
} from "../focus";

const TUE_9 = new Date(2026, 9, 6, 9, 0, 0);
const TUE_11 = new Date(2026, 9, 6, 11, 0, 0);

function ev(id: string, title: string, sh: number, eh: number): CalendarEventLike {
  return {
    id,
    title,
    startAt: new Date(2026, 9, 6, sh, 0, 0),
    endAt: new Date(2026, 9, 6, eh, 0, 0),
  };
}

const stubAdapter: CalendarAdapter = {
  provider: "manual",
  listEvents: async (start, end) => [
    ev("e1", "Team standup", 10, 11),
    ev("e2", "Lunch", 12, 13),
  ].filter((e) => e.startAt < end && e.endAt > start),
};

describe("validateFocusBlock", () => {
  it("accepts a valid block", () => {
    const v = validateFocusBlock({
      title: "Deep work — Q3 plan",
      startAt: TUE_9.toISOString(),
      endAt: TUE_11.toISOString(),
      recurrence: "weekdays",
      protection: "hard",
      source: "user",
    });
    assert.equal(v.ok, true);
    assert.equal(v.normalized?.recurrence, "weekdays");
    assert.equal(v.normalized?.protection, "hard");
  });

  it("rejects missing title, inverted times, and bad enums", () => {
    const v = validateFocusBlock({
      title: "  ",
      startAt: TUE_11.toISOString(),
      endAt: TUE_9.toISOString(),
      recurrence: "fortnightly",
      protection: "military",
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.length >= 4);
  });

  it("rejects blocks longer than 12 hours", () => {
    const v = validateFocusBlock({
      title: "x",
      startAt: new Date(2026, 9, 6, 0, 0).toISOString(),
      endAt: new Date(2026, 9, 6, 13, 0).toISOString(),
    });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /12 hours/);
  });

  it("defaults recurrence/protection/source", () => {
    const v = validateFocusBlock({
      title: "x",
      startAt: TUE_9.toISOString(),
      endAt: TUE_11.toISOString(),
    });
    assert.equal(v.normalized?.recurrence, "none");
    assert.equal(v.normalized?.protection, "soft");
    assert.equal(v.normalized?.source, "user");
  });
});

describe("findConflicts", () => {
  it("finds overlapping events with overlap minutes", () => {
    const c = findConflicts({ startAt: TUE_9, endAt: TUE_11 }, [
      ev("e1", "Team standup", 10, 11),
      ev("e2", "Lunch", 12, 13),
    ]);
    assert.equal(c.length, 1);
    assert.equal(c[0].eventId, "e1");
    assert.equal(c[0].overlapMin, 60);
  });

  it("treats back-to-back events as non-conflicting", () => {
    const c = findConflicts({ startAt: TUE_9, endAt: TUE_11 }, [ev("e2", "Lunch", 11, 12)]);
    assert.equal(c.length, 0);
  });
});

describe("suggestReschedules", () => {
  it("suggests the first free slot after the block", () => {
    const block = { startAt: TUE_9, endAt: TUE_11 };
    const events = [ev("e1", "Team standup", 10, 11), ev("e2", "Lunch", 12, 13)];
    const conflicts = findConflicts(block, events);
    const s = suggestReschedules(block, conflicts, events);
    assert.equal(s.length, 1);
    // 60-min event, 11:00 taken by nothing until 12:00 lunch → 11:00–12:00.
    assert.equal(s[0].suggestedStartAt.getHours(), 11);
    assert.equal(s[0].suggestedEndAt.getHours(), 12);
  });
});

describe("enforceFocusBlock", () => {
  const block = { id: "b1", startAt: TUE_9, endAt: TUE_11, protection: "soft" as const };

  it("soft protection never auto-declines and returns suggestions", async () => {
    const r = await enforceFocusBlock(block, stubAdapter, null);
    assert.equal(r.newStatus, "protected");
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.suggestions.length, 1);
    assert.deepEqual(r.autoDeclined, []);
  });

  it("soft protection works with no adapter at all", async () => {
    const r = await enforceFocusBlock(block, null, null);
    assert.equal(r.newStatus, "protected");
    assert.deepEqual(r.conflicts, []);
  });

  it("hard protection fails closed with NO_CALENDAR when no calendar is connected", async () => {
    const hard = { ...block, protection: "hard" as const };
    await assert.rejects(() => enforceFocusBlock(hard, null, null), (e: unknown) => {
      assert.ok(e instanceof WfhFocusError);
      assert.equal(e.code, "NO_CALENDAR");
      return true;
    });
  });

  it("hard protection fails closed with CONSENT_REQUIRED before the one-time consent", async () => {
    const hard = { ...block, protection: "hard" as const };
    await assert.rejects(
      () => enforceFocusBlock(hard, stubAdapter, { provider: "google", status: "connected", autoDeclineConsentAt: null }),
      (e: unknown) => {
        assert.ok(e instanceof WfhFocusError);
        assert.equal(e.code, "CONSENT_REQUIRED");
        return true;
      },
    );
  });

  it("hard protection with consent marks conflicts pending (rail parked)", async () => {
    const hard = { ...block, protection: "hard" as const };
    const r = await enforceFocusBlock(
      hard,
      stubAdapter,
      { provider: "google", status: "connected", autoDeclineConsentAt: new Date() },
    );
    assert.equal(r.newStatus, "protected");
    assert.deepEqual(r.autoDeclined, ["e1"]);
    assert.match(r.note, /pending auto-decline/);
  });
});

describe("transitionStatus", () => {
  it("allows the legal transitions", () => {
    assert.doesNotThrow(() => transitionStatus("scheduled", "protected"));
    assert.doesNotThrow(() => transitionStatus("protected", "overridden"));
    assert.doesNotThrow(() => transitionStatus("overridden", "protected"));
    assert.doesNotThrow(() => transitionStatus("protected", "completed"));
  });

  it("rejects illegal transitions", () => {
    assert.throws(() => transitionStatus("completed", "protected"), (e: unknown) => {
      assert.ok(e instanceof WfhFocusError);
      assert.equal(e.code, "INVALID_TRANSITION");
      return true;
    });
    assert.throws(() => transitionStatus("scheduled", "completed"), WfhFocusError);
  });
});

describe("expandRecurrence", () => {
  it("expands weekdays skipping weekends", () => {
    // Block starts Monday 2026-10-05 09:00–11:00, expand 8 days.
    const occ = expandRecurrence(
      {
        startAt: new Date(2026, 9, 5, 9, 0, 0),
        endAt: new Date(2026, 9, 5, 11, 0, 0),
        recurrence: "weekdays",
      },
      8,
    );
    // Mon–Fri + next Monday = 6 occurrences; Sat/Sun skipped.
    assert.equal(occ.length, 6);
    assert.ok(occ.every((o) => o.startAt.getDay() !== 0 && o.startAt.getDay() !== 6));
  });

  it("expands weekly on the same weekday", () => {
    const occ = expandRecurrence(
      {
        startAt: new Date(2026, 9, 5, 9, 0, 0),
        endAt: new Date(2026, 9, 5, 11, 0, 0),
        recurrence: "weekly",
      },
      21,
    );
    assert.equal(occ.length, 3);
    assert.ok(occ.every((o) => o.startAt.getDay() === 1));
  });

  it("returns the single block for none", () => {
    const occ = expandRecurrence({ startAt: TUE_9, endAt: TUE_11, recurrence: "none" }, 30);
    assert.equal(occ.length, 1);
  });
});

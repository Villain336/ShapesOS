// ShapesOS — Phase 18.2 (WS=comms): Reminders, the pure parts (unit).
// Repeats step on LOCAL dates in the member's time zone, so 09:00 stays
// 09:00 across daylight-saving changes; monthly clamps the day.
// Run: npx tsx --test lib/comms/__tests__/reminders.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRepeatRule, nextOccurrence, nextOccurrenceAfter, toReminderView, validateReminder } from "../reminders";
import { dueGroup, isoToWall, wallToIso } from "../time";

describe("nextOccurrence (time zones, DST)", () => {
  it("daily keeps 09:00 local across the US spring-forward (EST → EDT)", () => {
    const due = new Date("2026-03-07T14:00:00Z"); // 09:00 EST
    assert.equal(nextOccurrence(due, "daily", "America/New_York").toISOString(), "2026-03-08T13:00:00.000Z"); // 09:00 EDT
  });
  it("weekly keeps 09:00 local across the US fall-back (EDT → EST)", () => {
    const due = new Date("2026-10-31T13:00:00Z"); // Sat 09:00 EDT
    assert.equal(nextOccurrence(due, "weekly", "America/New_York").toISOString(), "2026-11-07T14:00:00.000Z"); // Sat 09:00 EST
  });
  it("Europe/Madrid: the same wall time after the clocks go back", () => {
    const due = new Date("2026-10-24T07:30:00Z"); // 09:30 CEST
    assert.equal(nextOccurrence(due, "daily", "Europe/Madrid").toISOString(), "2026-10-25T08:30:00.000Z"); // 09:30 CET
  });
  it("monthly clamps Jan 31 to the end of February, then continues from there", () => {
    const due = new Date("2026-01-31T09:00:00Z");
    const feb = nextOccurrence(due, "monthly", "UTC");
    assert.equal(feb.toISOString(), "2026-02-28T09:00:00.000Z");
    assert.equal(nextOccurrence(new Date("2028-01-31T09:00:00Z"), "monthly", "UTC").toISOString(), "2028-02-29T09:00:00.000Z", "leap year");
  });
  it("month and year roll over (daily on Dec 31)", () => {
    assert.equal(nextOccurrence(new Date("2026-12-31T22:00:00Z"), "daily", "UTC").toISOString(), "2027-01-01T22:00:00.000Z");
  });
  it("an unknown zone falls back to UTC instead of throwing", () => {
    assert.equal(nextOccurrence(new Date("2026-05-01T08:00:00Z"), "daily", "Mars/Olympus").toISOString(), "2026-05-02T08:00:00.000Z");
  });
  it("nextOccurrenceAfter skips the occurrences already in the past", () => {
    const due = new Date("2026-10-01T09:00:00Z");
    const now = new Date("2026-10-05T12:00:00Z");
    assert.equal(nextOccurrenceAfter(due, "daily", "UTC", now).toISOString(), "2026-10-06T09:00:00.000Z");
    assert.equal(nextOccurrenceAfter(due, "weekly", "UTC", now).toISOString(), "2026-10-08T09:00:00.000Z");
  });
});

describe("validateReminder", () => {
  it("needs a title; a repeat needs a due time; only three repeats", () => {
    assert.equal(validateReminder({ title: "  " }), "Write what to remember.");
    assert.equal(validateReminder({ title: "x".repeat(301) }), "Keep it under 300 characters.");
    assert.equal(validateReminder({ title: "Pay rent", repeat: "monthly" }), "A repeating reminder needs a due time.");
    assert.equal(validateReminder({ title: "Pay rent", repeat: "yearly", dueAt: new Date() }), "Repeat is daily, weekly or monthly.");
    assert.equal(validateReminder({ title: "Pay rent", dueAt: new Date("nope") }), "Pick a valid due time.");
    assert.equal(validateReminder({ title: "Pay rent", repeat: "monthly", dueAt: new Date() }), null);
    assert.ok(isRepeatRule("weekly") && !isRepeatRule("hourly"));
  });
});

describe("toReminderView", () => {
  const base = { id: "r1", title: "Send deck", description: null, repeatRule: null, completedAt: null, sourceRef: null, createdAt: new Date("2026-10-01T00:00:00Z") };
  it("overdue only when open and past due; done covers done and cancelled", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    assert.equal(toReminderView({ ...base, stage: "todo", dueAt: new Date("2026-10-06T09:00:00Z") }, now).overdue, true);
    assert.equal(toReminderView({ ...base, stage: "done", dueAt: new Date("2026-10-06T09:00:00Z") }, now).overdue, false);
    assert.equal(toReminderView({ ...base, stage: "cancelled", dueAt: null }, now).done, true);
    assert.equal(toReminderView({ ...base, stage: "todo", dueAt: null, repeatRule: "bogus" }, now).repeat, null);
  });
});

describe("wall time ↔ instant (the pickers)", () => {
  it("a datetime-local value is read in the member's zone", () => {
    assert.equal(wallToIso("2026-10-12T09:00", "America/Los_Angeles"), "2026-10-12T16:00:00.000Z");
    assert.equal(isoToWall("2026-10-12T16:00:00.000Z", "America/Los_Angeles"), "2026-10-12T09:00");
    assert.equal(wallToIso("garbage", "UTC"), null);
  });
  it("groups: overdue, today (local day), later, none", () => {
    const now = new Date("2026-10-06T20:00:00Z"); // 13:00 in LA
    assert.equal(dueGroup(null, now, "UTC"), "none");
    assert.equal(dueGroup("2026-10-06T19:00:00Z", now, "UTC"), "overdue");
    assert.equal(dueGroup("2026-10-07T05:00:00Z", now, "America/Los_Angeles"), "today", "22:00 the same LA day");
    assert.equal(dueGroup("2026-10-07T05:00:00Z", now, "UTC"), "later");
  });
});

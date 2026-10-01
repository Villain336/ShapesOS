// Marketr — Wave 2 WFH mode slice 5: ritual domain tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateRitual,
  nextOccurrence,
  occurrencesSince,
  assessRitualHealth,
  RITUAL_TYPE_META,
} from "../rituals";

describe("validateRitual", () => {
  it("accepts a valid ritual with defaults filled", () => {
    const v = validateRitual({ type: "kudos" });
    assert.equal(v.ok, true);
    assert.equal(v.normalized?.cadence, "weekly");
    assert.equal(v.normalized?.title, RITUAL_TYPE_META.kudos.name);
    assert.ok(v.normalized?.anchorDate instanceof Date);
  });

  it("rejects unknown types and bad cadences", () => {
    const v = validateRitual({ type: "pizza-party" as never, cadence: "yearly" as never });
    assert.equal(v.ok, false);
    assert.ok(v.errors.length >= 2);
  });

  it("rejects overlong titles", () => {
    const v = validateRitual({ type: "wins", title: "w".repeat(121) });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /120/);
  });

  it("defaults the anchor to next Monday noon UTC", () => {
    // Thursday 2026-10-01.
    const v = validateRitual({ type: "wins" }, new Date(2026, 9, 1, 15, 0, 0));
    assert.equal(v.normalized?.anchorDate.toISOString(), "2026-10-05T12:00:00.000Z");
  });
});

describe("cadence engine", () => {
  const anchor = new Date("2026-10-05T12:00:00.000Z"); // Monday

  it("nextOccurrence returns the anchor when it is in the future", () => {
    const n = nextOccurrence(anchor, "weekly", new Date("2026-10-01T00:00:00.000Z"));
    assert.equal(n.toISOString(), anchor.toISOString());
  });

  it("nextOccurrence steps forward past elapsed time", () => {
    const n = nextOccurrence(anchor, "weekly", new Date("2026-10-20T00:00:00.000Z"));
    assert.equal(n.toISOString(), "2026-10-26T12:00:00.000Z");
  });

  it("occurrencesSince lists every fire in a window", () => {
    const occ = occurrencesSince(
      anchor,
      "weekly",
      new Date("2026-10-01T00:00:00.000Z"),
      new Date("2026-10-31T23:59:59.000Z"),
    );
    assert.deepEqual(
      occ.map((d) => d.toISOString()),
      [
        "2026-10-05T12:00:00.000Z",
        "2026-10-12T12:00:00.000Z",
        "2026-10-19T12:00:00.000Z",
        "2026-10-26T12:00:00.000Z",
      ],
    );
  });
});

describe("dead-ritual surfacing", () => {
  const anchor = new Date("2026-09-01T12:00:00.000Z");
  const occ = [
    new Date("2026-09-07T12:00:00.000Z"),
    new Date("2026-09-14T12:00:00.000Z"),
    new Date("2026-09-21T12:00:00.000Z"),
    new Date("2026-09-28T12:00:00.000Z"),
  ];

  it("flags a ritual with no participation over 4 rounds", () => {
    const v = assessRitualHealth({
      ritualId: "r1",
      anchorDate: anchor,
      cadence: "weekly",
      active: true,
      recentOccurrences: occ,
      participationCount: 0,
      subscriberCount: 5,
    });
    assert.equal(v.dead, true);
    assert.match(v.reason ?? "", /No participation/);
    assert.match(v.suggestion ?? "", /Retire/);
  });

  it("flags a ritual with zero subscribers", () => {
    const v = assessRitualHealth({
      ritualId: "r1",
      anchorDate: anchor,
      cadence: "weekly",
      active: true,
      recentOccurrences: occ,
      participationCount: 10,
      subscriberCount: 0,
    });
    assert.equal(v.dead, true);
    assert.match(v.reason ?? "", /Nobody is subscribed/);
  });

  it("leaves healthy, young, and retired rituals alone", () => {
    const healthy = assessRitualHealth({
      ritualId: "r1",
      anchorDate: anchor,
      cadence: "weekly",
      active: true,
      recentOccurrences: occ,
      participationCount: 12,
      subscriberCount: 5,
    });
    assert.equal(healthy.dead, false);

    const young = assessRitualHealth({
      ritualId: "r2",
      anchorDate: anchor,
      cadence: "weekly",
      active: true,
      recentOccurrences: occ.slice(0, 2),
      participationCount: 0,
      subscriberCount: 5,
    });
    assert.equal(young.dead, false);

    const retired = assessRitualHealth({
      ritualId: "r3",
      anchorDate: anchor,
      cadence: "weekly",
      active: false,
      recentOccurrences: occ,
      participationCount: 0,
      subscriberCount: 0,
    });
    assert.equal(retired.dead, false);
  });
});

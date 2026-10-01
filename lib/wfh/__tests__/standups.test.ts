// Marketr — Wave 2 WFH mode slice 4: async standup domain tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateStandup,
  validateComment,
  validateReaction,
  isStandupDue,
  isStandupLate,
  nudgeCopy,
} from "../standups";

describe("validateStandup", () => {
  it("accepts a complete standup", () => {
    const v = validateStandup({
      date: new Date(2026, 9, 1),
      yesterday: "Shipped the focus engine",
      today: "Starting async standups",
      blockers: "Waiting on API key",
      visibility: "team",
    });
    assert.equal(v.ok, true);
    assert.equal(v.normalized?.blockers, "Waiting on API key");
    assert.equal(v.normalized?.videoUrl, null);
  });

  it("accepts a video URL and a private standup", () => {
    const v = validateStandup({
      date: "2026-10-01",
      yesterday: "x",
      today: "y",
      videoUrl: "https://example.com/v.mp4",
      visibility: "private",
    });
    assert.equal(v.ok, true);
    assert.equal(v.normalized?.videoUrl, "https://example.com/v.mp4");
  });

  it("rejects missing yesterday/today, bad visibility, non-http video", () => {
    const v = validateStandup({
      date: new Date(2026, 9, 1),
      yesterday: "   ",
      today: "",
      visibility: "everyone" as "team",
      videoUrl: "ftp://x",
    });
    assert.equal(v.ok, false);
    assert.ok(v.errors.length >= 3);
  });

  it("rejects overlong fields", () => {
    const v = validateStandup({
      date: new Date(2026, 9, 1),
      yesterday: "y".repeat(2001),
      today: "t",
      visibility: "team",
    });
    assert.equal(v.ok, false);
    assert.match(v.errors.join(" "), /2000/);
  });
});

describe("validateComment / validateReaction", () => {
  it("accepts a normal comment", () => {
    const c = validateComment("Nice — unblocked now?");
    assert.equal(c.ok, true);
    assert.equal(c.text, "Nice — unblocked now?");
  });

  it("rejects empty and overlong comments", () => {
    assert.equal(validateComment("  ").ok, false);
    assert.equal(validateComment("x".repeat(1001)).ok, false);
  });

  it("accepts a single emoji reaction and rejects text", () => {
    assert.equal(validateReaction("🎉").ok, true);
    assert.equal(validateReaction("🎉🎉🎉🎉🎉").ok, false);
    assert.equal(validateReaction("").ok, false);
  });
});

describe("standup due / nudge logic", () => {
  const MON = new Date(2026, 9, 5, 8, 0, 0); // Monday 08:00
  const SAT = new Date(2026, 9, 3, 8, 0, 0); // Saturday

  it("is due on a workday when nothing submitted", () => {
    assert.equal(isStandupDue("daily", MON, false), true);
    assert.equal(isStandupDue("weekdays", MON, false), true);
  });

  it("is not due after submitting, on weekends under weekdays, or when cadence is none", () => {
    assert.equal(isStandupDue("daily", MON, true), false);
    assert.equal(isStandupDue("weekdays", SAT, false), false);
    assert.equal(isStandupDue("daily", SAT, false), true); // daily includes weekends
    assert.equal(isStandupDue("none", MON, false), false);
  });

  it("detects lateness against the due hour", () => {
    assert.equal(isStandupLate(new Date(2026, 9, 5, 8, 0, 0), 10), false);
    assert.equal(isStandupLate(new Date(2026, 9, 5, 11, 0, 0), 10), true);
  });

  it("writes gentle, non-mandating nudge copy", () => {
    assert.equal(nudgeCopy(false, false), null);
    assert.match(nudgeCopy(true, false) ?? "", /keeps the team in sync/);
    assert.match(nudgeCopy(true, true) ?? "", /No rush/);
  });
});

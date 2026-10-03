// ShapesOS — workflow schedule cron reuses the scheduler's parser: standard
// OR semantics, 0/7 = Sunday, out-of-range rejected, explicit IANA timezone
// (regression for the edge/p1.ts + wf-cron.ts probes).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cronDue, parseCron, parseTimeZone, startOfCurrentMinute } from "../cron";

const NY = "America/New_York";

describe("workflow cron", () => {
  it("rejects out-of-range values instead of silently dropping them", () => {
    assert.throws(() => parseCron("5,70 * * * *"));
    assert.throws(() => parseCron("-5 * * * *"));
    assert.throws(() => parseCron("1-2-3 * * * *"));
    assert.throws(() => parseCron("0 9 * *"));
  });

  it("day-of-month OR day-of-week when both are restricted", () => {
    // Thu 2026-10-01 09:00 UTC: the 1st, not a Monday → standard cron fires.
    assert.equal(cronDue("0 9 1 * 1", new Date("2026-10-01T09:00:00Z")), true);
    assert.equal(cronDue("0 9 1 * 1", new Date("2026-10-05T09:00:00Z")), true);
    assert.equal(cronDue("0 9 1 * 1", new Date("2026-10-06T09:00:00Z")), false);
  });

  it("7 is Sunday, like 0", () => {
    assert.equal(cronDue("0 9 * * 7", new Date("2026-10-04T09:00:00Z")), true);
    assert.equal(cronDue("0 9 * * 0", new Date("2026-10-04T09:00:00Z")), true);
  });

  it("reads the schedule in the given IANA timezone, not the server's", () => {
    const expr = "0 9 * * 1-5";
    // Mon 2026-10-05 09:00 EDT = 13:00Z
    assert.equal(cronDue(expr, new Date("2026-10-05T13:00:00Z"), NY), true);
    assert.equal(cronDue(expr, new Date("2026-10-05T09:00:00Z"), NY), false);
    // Default is UTC.
    assert.equal(cronDue(expr, new Date("2026-10-05T09:00:00Z")), true);
    // After fall-back 09:00 EST = 14:00Z.
    assert.equal(cronDue(expr, new Date("2026-11-02T14:00:00Z"), NY), true);
    assert.equal(cronDue(expr, new Date("2026-11-02T13:00:00Z"), NY), false);
  });

  it("validates timezones", () => {
    assert.equal(parseTimeZone(undefined), "UTC");
    assert.equal(parseTimeZone(""), "UTC");
    assert.equal(parseTimeZone(NY), NY);
    assert.throws(() => parseTimeZone("Mars/Olympus"));
    assert.throws(() => cronDue("* * * * *", new Date(), "Not/AZone"));
  });

  it("startOfCurrentMinute truncates to the minute", () => {
    assert.equal(startOfCurrentMinute(new Date("2026-10-05T13:00:42.5Z")).toISOString(), "2026-10-05T13:00:00.000Z");
  });
});

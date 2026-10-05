// ShapesOS — IANA timezone helpers: DST gap/overlap, calendar math.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped,
  isValidTimeZone,
  resolveTimeZone,
  startOfZonedDay,
  zonedParts,
  zonedTimeToUtc,
} from "../zoned";

const NY = "America/New_York";

describe("zonedTimeToUtc", () => {
  it("converts an ordinary local time", () => {
    const r = zonedTimeToUtc(2026, 10, 5, 9 * 60, NY);
    assert.equal(r.resolution, "exact");
    assert.equal(r.date.toISOString(), "2026-10-05T13:00:00.000Z");
  });

  it("spring forward: 02:30 does not exist in New York → 03:30 EDT (gap)", () => {
    const r = zonedTimeToUtc(2026, 3, 8, 150, NY);
    assert.equal(r.resolution, "gap");
    assert.equal(r.date.toISOString(), "2026-03-08T07:30:00.000Z");
    // The hour either side is exact.
    assert.equal(zonedTimeToUtc(2026, 3, 8, 90, NY).date.toISOString(), "2026-03-08T06:30:00.000Z");
    assert.equal(zonedTimeToUtc(2026, 3, 8, 210, NY).date.toISOString(), "2026-03-08T07:30:00.000Z");
  });

  it("fall back: 01:30 happens twice → the earlier (EDT) instant, flagged ambiguous", () => {
    const r = zonedTimeToUtc(2026, 11, 1, 90, NY);
    assert.equal(r.resolution, "ambiguous");
    assert.equal(r.date.toISOString(), "2026-11-01T05:30:00.000Z");
    assert.equal(zonedTimeToUtc(2026, 11, 1, 9 * 60, NY).date.toISOString(), "2026-11-01T14:00:00.000Z");
  });

  it("UTC and fixed zones are exact", () => {
    assert.equal(zonedTimeToUtc(2028, 2, 29, 0, "UTC").date.toISOString(), "2028-02-29T00:00:00.000Z");
    assert.equal(zonedTimeToUtc(2026, 6, 1, 0, "Asia/Kolkata").date.toISOString(), "2026-05-31T18:30:00.000Z");
  });
});

describe("zonedParts", () => {
  it("reads local wall time and weekday", () => {
    const p = zonedParts(new Date("2026-10-05T03:59:00Z"), NY); // Sun 23:59 EDT
    assert.equal(p.ymd, "2026-10-04");
    assert.equal(p.weekday, 0);
    assert.equal(p.minutes, 23 * 60 + 59);
    assert.equal(zonedParts(new Date("2026-10-05T04:00:00Z"), NY).hour, 0);
  });
});

describe("startOfZonedDay", () => {
  it("is local midnight even on a 23-hour day", () => {
    assert.equal(startOfZonedDay(new Date("2026-03-08T20:00:00Z"), NY).toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(startOfZonedDay(new Date("2026-11-01T20:00:00Z"), NY).toISOString(), "2026-11-01T04:00:00.000Z");
  });
});

describe("addMonthsClamped", () => {
  it("clamps month-end and leap days", () => {
    assert.deepEqual(addMonthsClamped(2026, 1, 31, 1), { year: 2026, month: 2, day: 28 });
    assert.deepEqual(addMonthsClamped(2028, 1, 31, 1), { year: 2028, month: 2, day: 29 });
    assert.deepEqual(addMonthsClamped(2028, 2, 29, 12), { year: 2029, month: 2, day: 28 });
    assert.deepEqual(addMonthsClamped(2026, 11, 15, 3), { year: 2027, month: 2, day: 15 });
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names and rejects junk", () => {
    assert.equal(isValidTimeZone("America/New_York"), true);
    assert.equal(isValidTimeZone("UTC"), true);
    assert.equal(isValidTimeZone("Mars/Olympus"), false);
    assert.equal(isValidTimeZone(""), false);
    assert.equal(isValidTimeZone(42), false);
    assert.equal(resolveTimeZone("nope"), "UTC");
  });
});

// ShapesOS — Phase 2 (F): recurring legal deadlines are anchored to the
// series' original date, so the day-of-month never erodes. Regression for
// the 2026-10-03 audit probe (Jan 31 → Feb 28 → Mar 28 drift; a Feb 29
// annual deadline stuck on Feb 28 forever).
// Run: npx tsx --test lib/legal/__tests__/recurrence-anchor.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextOccurrenceFromAnchor, type DeadlineRecurrence } from "../deadlines";

const ymd = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

/** Walk a series the way markDeadlineDone does: anchor fixed, after = prev. */
function chain(anchorIso: string, recurrence: DeadlineRecurrence, n: number): string[] {
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  const out: string[] = [];
  let prev = anchor;
  for (let i = 0; i < n; i++) {
    prev = nextOccurrenceFromAnchor(anchor, prev, recurrence)!;
    out.push(ymd(prev)!);
  }
  return out;
}

describe("nextOccurrenceFromAnchor", () => {
  it("monthly from Jan 31 stays end-of-month", () => {
    assert.deepEqual(chain("2026-01-31", "monthly", 5), [
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
  });

  it("annual from Feb 29: Feb 28 in common years, back to Feb 29 in leap years", () => {
    assert.deepEqual(chain("2028-02-29", "annual", 5), [
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
      "2033-02-28",
    ]);
  });

  it("quarterly from Nov 30 keeps the 30th / month end", () => {
    assert.deepEqual(chain("2026-11-30", "quarterly", 4), ["2027-02-28", "2027-05-30", "2027-08-30", "2027-11-30"]);
  });

  it("none never recurs", () => {
    assert.equal(nextOccurrenceFromAnchor(new Date("2026-01-31T00:00:00Z"), new Date("2026-01-31T00:00:00Z"), "none"), null);
  });

  it("finds the next slot even when the completed occurrence is far from the anchor", () => {
    const anchor = new Date("2020-01-31T00:00:00Z");
    assert.equal(ymd(nextOccurrenceFromAnchor(anchor, new Date("2026-02-28T00:00:00Z"), "monthly")), "2026-03-31");
    assert.equal(ymd(nextOccurrenceFromAnchor(anchor, new Date("2026-01-31T00:00:00Z"), "biennial")), "2028-01-31");
  });
});

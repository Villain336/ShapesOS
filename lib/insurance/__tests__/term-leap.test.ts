// ShapesOS — policy term end on a leap day (FULL-AUDIT §5: a 2028-02-29
// effective date produced a term one day too long, ending 2029-03-01).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { policyTermEnd } from "../binding";

describe("policyTermEnd", () => {
  it("2028-02-29 + 1 year → 2029-02-28", () => {
    assert.equal(policyTermEnd(new Date("2028-02-29T00:00:00Z")).toISOString(), "2029-02-28T00:00:00.000Z");
  });

  it("keeps the time of day", () => {
    assert.equal(policyTermEnd(new Date("2028-02-29T05:00:00Z")).toISOString(), "2029-02-28T05:00:00.000Z");
  });

  it("ordinary dates move exactly one calendar year, into and out of leap years", () => {
    assert.equal(policyTermEnd(new Date("2026-10-01T00:00:00Z")).toISOString(), "2027-10-01T00:00:00.000Z");
    assert.equal(policyTermEnd(new Date("2027-02-28T00:00:00Z")).toISOString(), "2028-02-28T00:00:00.000Z");
    assert.equal(policyTermEnd(new Date("2027-03-01T00:00:00Z")).toISOString(), "2028-03-01T00:00:00.000Z");
    assert.equal(policyTermEnd(new Date("2026-12-31T23:59:00Z")).toISOString(), "2027-12-31T23:59:00.000Z");
  });
});

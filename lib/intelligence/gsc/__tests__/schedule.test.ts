// Marketr — Phase 10 M1 tests: long-tail weekly cadence policy.
// Run: npx tsx --test lib/intelligence/gsc/__tests__/schedule.test.ts
//
// Binds the Tico decision (SPEC-PHASE10 §10 Q3, locked 2026-09-26):
// long-tail tracked keywords stay on WEEKLY checks; head terms check daily.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLongTailKeyword,
  checkCadence,
  isCheckDue,
} from "../schedule";

const DAY = 24 * 60 * 60 * 1000;

describe("isLongTailKeyword", () => {
  it("flags 4+ word phrases as long-tail even with unknown volume", () => {
    assert.equal(isLongTailKeyword({ phrase: "best crm for small agencies 2026" }), true);
    assert.equal(isLongTailKeyword({ phrase: "how to rank on google maps" }), true);
  });
  it("flags low-volume keywords as long-tail", () => {
    assert.equal(isLongTailKeyword({ phrase: "seo tools", volume: 210 }), true);
    assert.equal(isLongTailKeyword({ phrase: "seo tools", volume: 0 }), true);
  });
  it("treats head terms as not long-tail", () => {
    assert.equal(isLongTailKeyword({ phrase: "seo tools", volume: 12_000 }), false);
    assert.equal(isLongTailKeyword({ phrase: "crm software", volume: 900 }), false);
  });
});

describe("checkCadence (scheduler defaults)", () => {
  it("defaults long-tail keywords to WEEKLY", () => {
    assert.equal(checkCadence({ phrase: "best crm for small agencies 2026" }), "weekly");
    assert.equal(checkCadence({ phrase: "seo tools", volume: 210 }), "weekly");
  });
  it("defaults head terms to daily", () => {
    assert.equal(checkCadence({ phrase: "seo tools", volume: 12_000 }), "daily");
    assert.equal(checkCadence({ phrase: "crm software", volume: 900 }), "daily");
  });
});

describe("isCheckDue", () => {
  const now = new Date("2026-09-26T12:00:00Z");
  const longtail = { phrase: "best crm for small agencies 2026" };
  const head = { phrase: "seo tools", volume: 12_000 };

  it("a never-checked keyword is always due", () => {
    assert.equal(isCheckDue(longtail, null, now), true);
    assert.equal(isCheckDue(head, null, now), true);
  });
  it("long-tail keywords are NOT due 3 days after a check (weekly)", () => {
    assert.equal(isCheckDue(longtail, new Date(now.getTime() - 3 * DAY), now), false);
  });
  it("long-tail keywords ARE due 7+ days after a check", () => {
    assert.equal(isCheckDue(longtail, new Date(now.getTime() - 7 * DAY), now), true);
    assert.equal(isCheckDue(longtail, new Date(now.getTime() - 8 * DAY), now), true);
  });
  it("head terms are due 24h after a check (daily)", () => {
    assert.equal(isCheckDue(head, new Date(now.getTime() - 23 * 60 * 60 * 1000), now), false);
    assert.equal(isCheckDue(head, new Date(now.getTime() - 25 * 60 * 60 * 1000), now), true);
  });
});

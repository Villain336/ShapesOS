// ShapesOS - pacing of visit reports (POST /api/desk/recents).
// Run: npx tsx --test lib/desktop/__tests__/recents-pacing.test.ts
//
// Regression: every navigation posted a visit, so a user (or the serial e2e suite, one user) moving
// quickly spent the 60-a-minute write budget on optional telemetry and got 429s, on the visit
// report and on real saves. Production limits are unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RECENTS_DEFAULT_BACKOFF_MS,
  RECENTS_MIN_GAP_MS,
  RECENTS_SETTLE_MS,
  recentsBackoffMs,
  recentsPostDelay,
} from "../recents";

describe("recentsPostDelay", () => {
  it("the first visit waits only for the page to settle", () => {
    assert.equal(recentsPostDelay({ now: 1000, lastSentAt: null, pausedUntil: null }), RECENTS_SETTLE_MS);
  });
  it("a visit soon after a report waits out the minimum gap", () => {
    assert.equal(recentsPostDelay({ now: 10_000, lastSentAt: 9_000, pausedUntil: null }), RECENTS_MIN_GAP_MS - 1000);
  });
  it("a visit long after a report is reported as soon as it settles", () => {
    assert.equal(recentsPostDelay({ now: 60_000, lastSentAt: 1_000, pausedUntil: null }), RECENTS_SETTLE_MS);
  });
  it("never reports while the server has asked for a back-off", () => {
    assert.equal(recentsPostDelay({ now: 10_000, lastSentAt: null, pausedUntil: 25_000 }), 15_000);
  });
  it("sixty navigations in a minute produce at most twelve reports", () => {
    let now = 0;
    let last: number | null = null;
    let posts = 0;
    for (let i = 0; i < 60; i++) {
      now += 1000; // one navigation a second
      const due = now + recentsPostDelay({ now, lastSentAt: last, pausedUntil: null });
      // the next navigation (1s later) cancels a pending report; only a report that fires counts
      if (due <= now + 1000) {
        last = due;
        posts++;
      }
    }
    assert.ok(posts <= 12, `posts=${posts}`);
  });
});

describe("recentsBackoffMs", () => {
  it("honours Retry-After seconds, bounded", () => {
    assert.equal(recentsBackoffMs("12"), 12_000);
    assert.equal(recentsBackoffMs("0"), RECENTS_DEFAULT_BACKOFF_MS);
    assert.equal(recentsBackoffMs("99999"), 600_000);
  });
  it("falls back to the default when the header is missing or not a number", () => {
    assert.equal(recentsBackoffMs(null), RECENTS_DEFAULT_BACKOFF_MS);
    assert.equal(recentsBackoffMs("soon"), RECENTS_DEFAULT_BACKOFF_MS);
  });
});

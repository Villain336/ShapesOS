// Marketr — Wave 2 context.dev slice 4 tests: monitor engine (pure).
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/monitor.test.ts
//
// Pure: no database, no network. Covers cadence due-calculation, the
// content diff digest (added/removed counts, excerpt), and hash
// determinism. The DB-touching runDueMonitors stays thin over these.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isDue, diffContent, CADENCE_INTERVAL_MS } from "../monitor";
import { contentHash } from "../crawl";

describe("isDue", () => {
  const now = new Date("2026-10-01T12:00:00Z");

  it("a never-checked monitor is always due", () => {
    assert.equal(isDue(null, "weekly", now), true);
  });

  it("respects each cadence interval", () => {
    const justUnder = (ms: number) => new Date(now.getTime() - ms + 60_000);
    const justOver = (ms: number) => new Date(now.getTime() - ms - 60_000);
    for (const cadence of ["hourly", "daily", "weekly"] as const) {
      const interval = CADENCE_INTERVAL_MS[cadence];
      assert.equal(isDue(justUnder(interval), cadence, now), false, `${cadence} under`);
      assert.equal(isDue(justOver(interval), cadence, now), true, `${cadence} over`);
    }
  });

  it("an exactly-elapsed interval is due", () => {
    const exact = new Date(now.getTime() - CADENCE_INTERVAL_MS.daily);
    assert.equal(isDue(exact, "daily", now), true);
  });
});

describe("diffContent", () => {
  it("counts added and removed lines", () => {
    const d = diffContent("a\nb\nc", "a\nc\nd");
    assert.equal(d.added, 1);
    assert.equal(d.removed, 1);
    assert.deepEqual(d.addedLines, ["d"]);
    assert.deepEqual(d.removedLines, ["b"]);
    assert.ok(d.digest.includes("1 line added"));
    assert.ok(d.digest.includes("1 line removed"));
  });

  it("reports identical content as no change", () => {
    const d = diffContent("a\nb", "a\nb");
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
  });

  it("ignores blank-line and whitespace noise", () => {
    const d = diffContent("a\n\nb  ", "a\nb");
    assert.equal(d.added, 0);
    assert.equal(d.removed, 0);
  });

  it("builds an excerpt of the first changed lines", () => {
    const d = diffContent("old line", "new line one\nnew line two");
    assert.ok(d.excerpt.includes("+ new line one"));
    assert.ok(d.excerpt.includes("- old line"));
  });

  it("is deterministic", () => {
    const a = diffContent("x\ny", "x\nz");
    const b = diffContent("x\ny", "x\nz");
    assert.deepEqual(a, b);
  });
});

describe("contentHash (dedup key)", () => {
  it("is stable for identical content, distinct for changed content", () => {
    assert.equal(contentHash("hello"), contentHash("hello"));
    assert.notEqual(contentHash("hello"), contentHash("hello!"));
  });
});

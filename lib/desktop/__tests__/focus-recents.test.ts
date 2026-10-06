// ShapesOS — Phase 18.1 (WS=desk): focus-mode queueing rules and recents rules.
// Run: npx tsx --test lib/desktop/__tests__/focus-recents.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FOCUS_MAX_MINUTES, FOCUS_PRESETS, focusEndsAt, holdDecision, isFocusActive, shouldRelease, validFocusEnd } from "../focus";
import { classifyRecent, normalizeRecentHref, recentTitle } from "../recents";

const NOW = new Date("2026-10-06T10:00:00Z");
const inMin = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("focus mode queues, never drops", () => {
  it("every notification kind waits while focus is on", () => {
    const state = { focusUntil: inMin(60) };
    for (const kind of ["approval_needed", "approval_decided", "alert_fired", "run_failed", "invite_accepted"]) {
      const d = holdDecision(kind, state, NOW);
      assert.equal(d.hold, true, kind);
      assert.equal(d.hold && d.until.toISOString(), inMin(60).toISOString());
    }
  });

  it("nothing waits when focus is off or has ended", () => {
    assert.equal(holdDecision("run_failed", null, NOW).hold, false);
    assert.equal(holdDecision("run_failed", { focusUntil: null }, NOW).hold, false);
    assert.equal(holdDecision("run_failed", { focusUntil: inMin(-1) }, NOW).hold, false);
    assert.equal(holdDecision("run_failed", { focusUntil: NOW }, NOW).hold, false, "the end instant is already off");
  });

  it("held rows are released exactly when focus is not on", () => {
    assert.equal(shouldRelease({ focusUntil: inMin(5) }, NOW), false);
    assert.equal(shouldRelease({ focusUntil: inMin(-5) }, NOW), true);
    assert.equal(shouldRelease(null, NOW), true);
  });

  it("focus always has an end time within the limit", () => {
    assert.equal(focusEndsAt(30, NOW).toISOString(), inMin(30).toISOString());
    for (const p of FOCUS_PRESETS) assert.ok(validFocusEnd(focusEndsAt(p.minutes, NOW), NOW), p.label);
    assert.throws(() => focusEndsAt(0, NOW));
    assert.throws(() => focusEndsAt(FOCUS_MAX_MINUTES + 1, NOW));
    assert.throws(() => focusEndsAt(12.5, NOW));
    assert.throws(() => focusEndsAt(Number.NaN, NOW));
    assert.equal(validFocusEnd(inMin(-1), NOW), false);
    assert.equal(validFocusEnd(inMin(FOCUS_MAX_MINUTES + 1), NOW), false);
    assert.equal(isFocusActive({ focusUntil: inMin(1) }, NOW), true);
  });
});

describe("recents", () => {
  it("only same-app dashboard paths are remembered, query and hash dropped", () => {
    assert.equal(normalizeRecentHref("/dashboard/crm?tab=deals#x"), "/dashboard/crm");
    assert.equal(normalizeRecentHref("/dashboard/projects/abc123/"), "/dashboard/projects/abc123");
    assert.equal(normalizeRecentHref("/dashboard"), "/dashboard");
    for (const bad of ["https://evil.test/dashboard", "//evil.test", "/dashboardx", "/api/x", "/dashboard\\..\\x", "/dashboard/a b", 42, null]) {
      assert.equal(normalizeRecentHref(bad), null, String(bad));
    }
    assert.equal(normalizeRecentHref(`/dashboard/${"x".repeat(400)}`), null);
  });

  it("the shell's own pages are not recents", () => {
    assert.equal(normalizeRecentHref("/dashboard/switch"), null);
    assert.equal(normalizeRecentHref("/dashboard/split?left=/dashboard/crm"), null);
    assert.equal(normalizeRecentHref("/dashboard/welcome"), null);
  });

  it("apps vs records", () => {
    assert.equal(classifyRecent("/dashboard/crm"), "app");
    assert.equal(classifyRecent("/dashboard/intelligence"), "app", "an activePrefix is an app");
    assert.equal(classifyRecent("/dashboard/projects/cmabc0000000000000000000"), "record");
  });

  it("titles strip the product suffix and fall back to the app name", () => {
    assert.equal(recentTitle("/dashboard/crm", "CRM — ShapesOS"), "CRM");
    assert.equal(recentTitle("/dashboard/crm", ""), "CRM");
    assert.equal(recentTitle("/dashboard/projects/cmabc0000000000000000000", "ShapesOS"), "SEO projects · record cmabc000");
    assert.equal(recentTitle("/dashboard/ops/invoices/inv-42", "Invoice INV-42 — ShapesOS"), "Invoice INV-42");
  });
});

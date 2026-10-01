// Marketr — Wave 2 WFH mode slice 2: async-first notification routing tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUrgency,
  resolveDigestWindows,
  routeNotification,
  nextWindowMin,
  dueWindowsFor,
  assembleDigest,
  DEFAULT_DIGEST_TIMES_MIN,
  type RoutingContext,
} from "../notifications";
import type { WorkModeState } from "../mode";

function wfhState(): WorkModeState {
  return { mode: "wfh", wfhDays: [], setupCompletedAt: new Date() };
}
function officeState(): WorkModeState {
  return { mode: "office", wfhDays: [], setupCompletedAt: null };
}
// Tuesday 2026-10-06 10:30 local.
const TUE_1030 = new Date(2026, 9, 6, 10, 30, 0);

describe("classifyUrgency", () => {
  it("breaks through approval gates, money, and customer-facing kinds", () => {
    for (const kind of [
      "approval_requested",
      "approval_decided",
      "money_moved",
      "payment_failed",
      "customer_message",
      "customer_escalation",
      "security_alert",
    ]) {
      assert.equal(classifyUrgency({ kind, title: "x" }), "urgent", kind);
    }
  });

  it("treats routine kinds and unknown kinds as routine", () => {
    assert.equal(classifyUrgency({ kind: "standup_reminder", title: "x" }), "routine");
    assert.equal(classifyUrgency({ kind: "some_future_kind", title: "x" }), "routine");
  });

  it("lets the explicit override win both ways", () => {
    assert.equal(
      classifyUrgency({ kind: "comment", title: "x", urgentOverride: true }),
      "urgent",
    );
    assert.equal(
      classifyUrgency({ kind: "approval_requested", title: "x", urgentOverride: false }),
      "routine",
    );
  });
});

describe("resolveDigestWindows", () => {
  it("defaults to 2x/day (09:00, 16:00)", () => {
    assert.deepEqual(resolveDigestWindows(null).timesMin, DEFAULT_DIGEST_TIMES_MIN);
    assert.deepEqual(resolveDigestWindows([]).timesMin, DEFAULT_DIGEST_TIMES_MIN);
  });

  it("sorts, dedupes, and drops out-of-range times", () => {
    assert.deepEqual(resolveDigestWindows([960, 540, 540, 2000, -5]).timesMin, [540, 960]);
  });
});

describe("routeNotification", () => {
  const base: RoutingContext = {
    mode: wfhState(),
    notificationProfile: "batched",
    at: TUE_1030,
  };

  it("urgent always delivers now, even in WFH batched mode", () => {
    const d = routeNotification({ kind: "approval_requested", title: "Spend proposal" }, base);
    assert.equal(d.deliver, "now");
    assert.equal(d.reason, "urgent_breakthrough");
  });

  it("routine batches to the next digest window in WFH mode", () => {
    const d = routeNotification({ kind: "comment", title: "Priya replied" }, base);
    assert.equal(d.deliver, "digest");
    assert.equal(d.reason, "batched_digest");
    if (d.deliver === "digest") assert.equal(d.windowMin, 960); // 10:30 -> 16:00 window
  });

  it("realtime profile delivers routine notifications now", () => {
    const d = routeNotification(
      { kind: "comment", title: "x" },
      { ...base, notificationProfile: "realtime" },
    );
    assert.deepEqual(d, { deliver: "now", reason: "realtime_profile" });
  });

  it("office mode delivers routine notifications now", () => {
    const d = routeNotification({ kind: "comment", title: "x" }, { ...base, mode: officeState() });
    assert.deepEqual(d, { deliver: "now", reason: "wfh_not_effective" });
  });

  it("hybrid mode on a non-WFH day delivers now", () => {
    const hybrid: WorkModeState = { mode: "hybrid", wfhDays: ["mon"], setupCompletedAt: new Date() };
    // TUE_1030 is a Tuesday; hybrid days = [mon] only.
    const d = routeNotification({ kind: "comment", title: "x" }, { ...base, mode: hybrid });
    assert.equal(d.deliver, "now");
  });
});

describe("nextWindowMin", () => {
  it("picks the next window at or after now", () => {
    assert.equal(nextWindowMin([540, 960], new Date(2026, 9, 6, 8, 0)), 540);
    assert.equal(nextWindowMin([540, 960], new Date(2026, 9, 6, 9, 0)), 540);
    assert.equal(nextWindowMin([540, 960], new Date(2026, 9, 6, 10, 30)), 960);
  });

  it("wraps to the first window after the last one passes", () => {
    assert.equal(nextWindowMin([540, 960], new Date(2026, 9, 6, 23, 0)), 540);
  });
});

describe("dueWindowsFor", () => {
  it("marks passed, unflushed windows as due", () => {
    const due = dueWindowsFor([540, 960], new Date(2026, 9, 6, 17, 0), {});
    assert.deepEqual(due, [540, 960]);
  });

  it("skips windows that already flushed today", () => {
    const due = dueWindowsFor([540, 960], new Date(2026, 9, 6, 17, 0), {
      540: new Date(2026, 9, 6, 9, 5).toISOString(),
      960: null,
    });
    assert.deepEqual(due, [960]);
  });

  it("does not mark future windows due", () => {
    const due = dueWindowsFor([540, 960], new Date(2026, 9, 6, 8, 0), {});
    assert.deepEqual(due, []);
  });

  it("treats a yesterday flush as due again today", () => {
    const due = dueWindowsFor([540], new Date(2026, 9, 6, 10, 0), {
      540: new Date(2026, 9, 5, 9, 5).toISOString(),
    });
    assert.deepEqual(due, [540]);
  });
});

describe("assembleDigest", () => {
  it("groups items by kind with counts and a human headline", () => {
    const d = assembleDigest(960, [
      { kind: "comment", title: "A", queuedAt: "x" },
      { kind: "comment", title: "B", queuedAt: "x" },
      { kind: "report_ready", title: "C", queuedAt: "x" },
    ]);
    assert.equal(d.itemCount, 3);
    assert.equal(d.groups.length, 2);
    assert.equal(d.groups[0].count, 2);
    assert.match(d.headline, /3 updates while you were focused/);
    assert.match(d.headline, /16:00/);
  });

  it("handles the empty digest gracefully", () => {
    const d = assembleDigest(540, []);
    assert.equal(d.itemCount, 0);
    assert.match(d.headline, /Nothing queued/);
  });
});

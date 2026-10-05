// ShapesOS — notifications in the kit's toast pattern.
// Run: npx tsx --test lib/aos/__tests__/notifications.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { notificationAction, notificationBanners, notificationStatus } from "../notifications";

describe("notificationStatus", () => {
  it("only agent states get a status; the rest are neutral", () => {
    assert.equal(notificationStatus({ kind: "approval_needed", title: "x" }), "needs");
    assert.equal(notificationStatus({ kind: "run_failed", title: "x" }), "failed");
    assert.equal(notificationStatus({ kind: "approval_decided", title: "Ad spend approved" }), "done");
    assert.equal(notificationStatus({ kind: "approval_decided", title: "Ad spend denied" }), null);
    assert.equal(notificationStatus({ kind: "alert_fired", title: "Brief published" }), null);
    assert.equal(notificationStatus({ kind: "invite_accepted", title: "Dana joined" }), null);
  });
});

describe("notificationAction", () => {
  it("one action named for where it goes", () => {
    assert.deepEqual(notificationAction({ kind: "approval_needed", href: "/dashboard/approvals" }), { label: "Review", href: "/dashboard/approvals" });
    assert.deepEqual(notificationAction({ kind: "run_failed", href: "/dashboard/runs/r1" }), { label: "Open run", href: "/dashboard/runs/r1" });
    assert.deepEqual(notificationAction({ kind: "invite_accepted", href: "/dashboard/settings/team" }), { label: "Open team", href: "/dashboard/settings/team" });
    assert.deepEqual(notificationAction({ kind: "alert_fired", href: "/dashboard/files" }), { label: "Open", href: "/dashboard/files" });
    assert.equal(notificationAction({ kind: "alert_fired", href: null }), null);
  });
});

describe("notificationBanners", () => {
  it("unread approvals then failures; read ones don't count", () => {
    const b = notificationBanners([
      { kind: "approval_needed", title: "Writer wants to send 14 emails", readAt: null },
      { kind: "approval_needed", title: "Old", readAt: "2026-10-01T00:00:00.000Z" },
      { kind: "run_failed", title: "Operator couldn't sync your calendar", body: "Calendar access expired. Reconnect to resume.", href: "/dashboard/runs", readAt: null },
    ]);
    assert.deepEqual(b.map((x) => x.status), ["needs", "failed"]);
    assert.equal(b[0]!.title, "1 approval is waiting on you");
    assert.deepEqual(b[0]!.action, { label: "Review all", href: "/dashboard/approvals" });
    assert.equal(b[1]!.title, "Operator couldn't sync your calendar");
    assert.equal(b[1]!.description, "Calendar access expired. Reconnect to resume.");
    assert.deepEqual(b[1]!.action, { label: "Open run", href: "/dashboard/runs" });
  });

  it("several failures collapse into one banner", () => {
    const b = notificationBanners([
      { kind: "run_failed", title: "A", readAt: null },
      { kind: "run_failed", title: "B", readAt: null },
    ]);
    assert.equal(b.length, 1);
    assert.equal(b[0]!.title, "2 runs stopped on errors");
    assert.deepEqual(b[0]!.action, { label: "Open runs", href: "/dashboard/runs" });
  });

  it("the live inbox count wins over notifications", () => {
    const b = notificationBanners([{ kind: "approval_needed", title: "x", readAt: null }], { approvals: 3 });
    assert.equal(b[0]!.title, "3 approvals are waiting on you");
    assert.deepEqual(notificationBanners([{ kind: "approval_needed", title: "x", readAt: null }], { approvals: 0 }), []);
  });

  it("nothing unread, no banners", () => {
    assert.deepEqual(notificationBanners([{ kind: "alert_fired", title: "x", readAt: null }]), []);
  });
});

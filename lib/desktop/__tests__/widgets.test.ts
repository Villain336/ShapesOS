// ShapesOS — Phase 18.1 (WS=desk): the widget registry is complete.
// Every widget has a loader, a view, a role and sane sizes; the split-view
// and switcher helpers keep panes on this app's dashboard.
// Run: npx tsx --test lib/desktop/__tests__/widgets.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { GRID_COLS, GRID_MAX_ROWS, WIDGETS, WIDGET_IDS, deskRoleAtLeast, widgetsForRole } from "../widgets";
import { WIDGET_LOADERS } from "../loaders.server";
import { WIDGET_VIEWS } from "@/components/desktop/widgets/views";
import { clampRatio, parseSplit, sanitizePaneHref, splitUrl, swapPanes } from "../split";
import { switcherEntries } from "@/components/desk/AppSwitcher";

const ROOT = path.resolve(__dirname, "../../..");
const ROLES = ["viewer", "editor", "admin", "owner"] as const;

describe("widget registry", () => {
  it("every widget has a loader and a view, and nothing extra", () => {
    assert.deepEqual(Object.keys(WIDGET_LOADERS).sort(), [...WIDGET_IDS].sort());
    assert.deepEqual(Object.keys(WIDGET_VIEWS).sort(), [...WIDGET_IDS].sort());
    for (const id of WIDGET_IDS) {
      assert.equal(typeof WIDGET_LOADERS[id], "function", `${id} loader`);
      assert.equal(typeof WIDGET_VIEWS[id], "function", `${id} view`);
    }
  });

  it("every widget has a role, an icon, a source and sizes inside the grid", () => {
    for (const id of WIDGET_IDS) {
      const w = WIDGETS[id];
      assert.equal(w.id, id);
      assert.ok(ROLES.includes(w.minRole as (typeof ROLES)[number]), `${id} role`);
      assert.ok(w.icon, `${id} icon`);
      assert.ok(w.title && w.title[0] === w.title[0]!.toUpperCase(), `${id} title`);
      assert.ok(w.source.length > 3, `${id} source`);
      for (const s of [w.minSize, w.defaultSize, w.maxSize]) {
        assert.ok(s.w >= 1 && s.w <= GRID_COLS && s.h >= 1 && s.h <= GRID_MAX_ROWS, `${id} size in grid`);
      }
      assert.ok(w.minSize.w <= w.defaultSize.w && w.defaultSize.w <= w.maxSize.w, `${id} width min ≤ default ≤ max`);
      assert.ok(w.minSize.h <= w.defaultSize.h && w.defaultSize.h <= w.maxSize.h, `${id} height min ≤ default ≤ max`);
      // "Open" goes to a real page.
      const page = path.join(ROOT, "app", ...w.href.split("/").filter(Boolean), "page.tsx");
      assert.ok(existsSync(page), `${id} → ${w.href} has no page`);
    }
  });

  it("the plan's widgets are all there", () => {
    for (const id of ["needs-you", "running", "calendar", "inbox", "twin", "pipeline", "cash", "briefing", "agents", "attention", "projects"]) {
      assert.ok((WIDGET_IDS as readonly string[]).includes(id), id);
    }
  });

  it("role gating: higher roles see everything lower roles see", () => {
    let prev = new Set<string>();
    for (const r of ROLES) {
      const ids = new Set(widgetsForRole(r).map((w) => w.id));
      for (const id of prev) assert.ok(ids.has(id as never), `${r} lost ${id}`);
      prev = ids;
    }
    assert.equal(widgetsForRole("intruder").length, widgetsForRole(null).length);
    assert.equal(deskRoleAtLeast("viewer", "admin"), false);
    assert.equal(deskRoleAtLeast("owner", "admin"), true);
    assert.equal(deskRoleAtLeast(undefined, "viewer"), false);
  });
});

describe("split view state", () => {
  it("panes are this app's dashboard pages only", () => {
    assert.equal(sanitizePaneHref("/dashboard/crm?tab=deals#x"), "/dashboard/crm?tab=deals");
    for (const bad of ["https://evil.test", "//evil.test/dashboard", "/api/x", "/dashboard/split", "/dashboard/split?left=/dashboard", "/dashboard/../api", "/dashboardx", "/dashboard\\x", "/dashboard/a b", null, 7]) {
      assert.equal(sanitizePaneHref(bad), null, String(bad));
    }
  });

  it("parses with safe fallbacks, clamps the ratio, round-trips the URL, swaps", () => {
    const s = parseSplit(new URLSearchParams("left=/dashboard/crm&right=https://x&ratio=95"));
    assert.deepEqual(s, { left: "/dashboard/crm", right: "/dashboard/assistant", ratio: 80 });
    assert.equal(clampRatio("abc"), 50);
    assert.equal(clampRatio(3), 20);
    const back = parseSplit(new URL(`http://x${splitUrl(s)}`).searchParams);
    assert.deepEqual(back, s);
    assert.deepEqual(swapPanes(s), { left: "/dashboard/assistant", right: "/dashboard/crm", ratio: 20 });
  });
});

describe("app switcher list", () => {
  const recents = [
    { href: "/dashboard/crm", title: "CRM", kind: "app" as const, visitedAt: "2026-10-06T10:00:00Z" },
    { href: "/dashboard/projects/abc", title: "acme.com", kind: "record" as const, visitedAt: "2026-10-06T09:00:00Z" },
    { href: "/dashboard/files", title: "Files", kind: "app" as const, visitedAt: "2026-10-06T08:00:00Z" },
  ];
  it("recents first (newest), never the current page, then pins and a few apps, no duplicates", () => {
    const list = switcherEntries(recents, ["/dashboard/studio", "/dashboard/crm"], "/dashboard/files", "owner");
    assert.deepEqual(list.slice(0, 3).map((e) => e.href), ["/dashboard/crm", "/dashboard/projects/abc", "/dashboard/studio"]);
    assert.equal(list[1]!.hint, "SEO projects record");
    assert.ok(!list.some((e) => e.href === "/dashboard/files"));
    assert.equal(new Set(list.map((e) => e.href)).size, list.length);
    assert.ok(list.length <= 8);
  });
  it("role-gated apps never appear through pins", () => {
    const list = switcherEntries([], ["/dashboard/billing"], "/dashboard", "viewer");
    assert.ok(!list.some((e) => e.href === "/dashboard/billing"));
  });
});

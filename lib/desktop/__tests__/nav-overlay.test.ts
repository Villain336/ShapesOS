// ShapesOS — Phase 18.1 (WS=desk): the dock overlay on lib/nav/config.ts.
// Run: npx tsx --test lib/desktop/__tests__/nav-overlay.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_PINS, movePin, pinnedNavItems, sanitizeNavPrefs, togglePin } from "../nav-overlay";
import { allNavItems, NAV_GROUPS, type NavGroup } from "@/lib/nav/config";

describe("dock pins (overlay, never a second nav)", () => {
  it("unknown / removed hrefs are dropped silently", () => {
    const p = sanitizeNavPrefs({ pinned: ["/dashboard/crm", "/dashboard/retired-app", "javascript:alert(1)", "/dashboard/studio"] }, "owner");
    assert.deepEqual(p.pinned, ["/dashboard/crm", "/dashboard/studio"]);
  });

  it("a nav item removed from the config disappears from every dock", () => {
    const without: NavGroup[] = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.href !== "/dashboard/crm") }));
    assert.deepEqual(sanitizeNavPrefs({ pinned: ["/dashboard/crm", "/dashboard/files"] }, "owner", without).pinned, ["/dashboard/files"]);
  });

  it("role-gated items stay gated when pinned", () => {
    const stored = { pinned: ["/dashboard/billing", "/dashboard/crm"] };
    assert.deepEqual(sanitizeNavPrefs(stored, "viewer").pinned, ["/dashboard/crm"]);
    assert.deepEqual(sanitizeNavPrefs(stored, "editor").pinned, ["/dashboard/crm"]);
    assert.deepEqual(sanitizeNavPrefs(stored, "admin").pinned, ["/dashboard/billing", "/dashboard/crm"]);
    assert.deepEqual(pinnedNavItems(stored, "viewer").map((i) => i.href), ["/dashboard/crm"]);
  });

  it("pinned items are the config's own items (same label, icon, href)", () => {
    const items = pinnedNavItems({ pinned: ["/dashboard/files", "/dashboard/crm"] }, "owner");
    const byHref = new Map(allNavItems().map((i) => [i.href, i]));
    for (const i of items) assert.equal(i, byHref.get(i.href));
    assert.deepEqual(items.map((i) => i.href), ["/dashboard/files", "/dashboard/crm"], "the member's order is kept");
  });

  it("duplicates collapse, malformed input is empty, the cap holds", () => {
    assert.deepEqual(sanitizeNavPrefs({ pinned: ["/dashboard/crm", "/dashboard/crm"] }, "owner").pinned, ["/dashboard/crm"]);
    assert.deepEqual(sanitizeNavPrefs("nope", "owner").pinned, []);
    assert.deepEqual(sanitizeNavPrefs({ pinned: [42] }, "owner").pinned, []);
    const many = { pinned: allNavItems().map((i) => i.href) };
    assert.equal(sanitizeNavPrefs(many, "owner").pinned.length, MAX_PINS);
  });

  it("toggle and reorder", () => {
    let p = { pinned: [] as string[] };
    p = togglePin(p, "/dashboard/crm");
    p = togglePin(p, "/dashboard/files");
    p = togglePin(p, "/dashboard/studio");
    assert.deepEqual(p.pinned, ["/dashboard/crm", "/dashboard/files", "/dashboard/studio"]);
    p = movePin(p, "/dashboard/studio", -1);
    assert.deepEqual(p.pinned, ["/dashboard/crm", "/dashboard/studio", "/dashboard/files"]);
    assert.deepEqual(movePin(p, "/dashboard/crm", -1), p, "clamps at the top");
    assert.deepEqual(movePin(p, "/dashboard/files", 1), p, "clamps at the bottom");
    p = togglePin(p, "/dashboard/crm");
    assert.deepEqual(p.pinned, ["/dashboard/studio", "/dashboard/files"]);
    const full = { pinned: allNavItems().slice(0, MAX_PINS).map((i) => i.href) };
    assert.deepEqual(togglePin(full, allNavItems()[MAX_PINS]!.href), full, "pinning past the cap is a no-op");
  });
});

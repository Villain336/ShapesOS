// ShapesOS — Phase 18.1 (WS=desk): desktop layout validation and editing.
// Run: npx tsx --test lib/desktop/__tests__/layout.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addWidget,
  defaultLayoutFor,
  layoutRows,
  moveBy,
  overlaps,
  removeWidget,
  resizeBy,
  sanitizeLayout,
  validateLayout,
  type DesktopLayout,
} from "../layout";
import { GRID_COLS, GRID_MAX_ROWS, MAX_WIDGETS, WIDGETS, WIDGET_IDS } from "../widgets";

const ROLES = ["viewer", "editor", "admin", "owner"] as const;

function noOverlap(l: DesktopLayout): boolean {
  for (let i = 0; i < l.widgets.length; i++)
    for (let j = i + 1; j < l.widgets.length; j++) if (overlaps(l.widgets[i]!, l.widgets[j]!)) return false;
  return true;
}

describe("default layouts", () => {
  for (const role of ROLES) {
    it(`${role}: valid, inside the grid, no overlap`, () => {
      const l = defaultLayoutFor(role);
      const v = validateLayout(l, role);
      assert.ok(v.ok, JSON.stringify(!v.ok && v.issues));
      assert.ok(l.widgets.length >= 6);
      assert.ok(noOverlap(l));
      // The briefing and Needs you open every desktop.
      assert.deepEqual(l.widgets.slice(0, 2).map((w) => w.widget), ["briefing", "needs-you"]);
    });
  }
  it("differs by role (admins see cash, editors the inbox)", () => {
    assert.ok(defaultLayoutFor("admin").widgets.some((w) => w.widget === "cash"));
    assert.ok(defaultLayoutFor("editor").widgets.some((w) => w.widget === "inbox"));
    assert.ok(!defaultLayoutFor("viewer").widgets.some((w) => w.widget === "cash"));
  });
  it("an unknown role gets the viewer default", () => {
    assert.deepEqual(defaultLayoutFor("intruder"), defaultLayoutFor("viewer"));
    assert.deepEqual(defaultLayoutFor(null), defaultLayoutFor("viewer"));
  });
});

describe("validateLayout", () => {
  const base = (widgets: DesktopLayout["widgets"]) => ({ version: 1, widgets });

  it("refuses overlap", () => {
    const v = validateLayout(base([
      { id: "agents", widget: "agents", x: 0, y: 0, w: 8, h: 5 },
      { id: "running", widget: "running", x: 6, y: 2, w: 4, h: 5 },
    ]), "owner");
    assert.equal(v.ok, false);
    assert.ok(!v.ok && v.issues.some((i) => i.code === "overlap"));
  });

  it("refuses out-of-bounds placements", () => {
    for (const p of [
      { x: -1, y: 0 },
      { x: GRID_COLS - 3, y: 0 }, // w 4 → past the right edge
      { x: 0, y: -2 },
      { x: 0, y: GRID_MAX_ROWS - 2 }, // h 4 → past the last row
    ]) {
      const v = validateLayout(base([{ id: "inbox", widget: "inbox", w: 4, h: 4, ...p }]), "owner");
      assert.ok(!v.ok && v.issues.some((i) => i.code === "bounds"), JSON.stringify(p));
    }
  });

  it("refuses sizes outside the widget's min/max", () => {
    const tooSmall = validateLayout(base([{ id: "agents", widget: "agents", x: 0, y: 0, w: 2, h: 2 }]), "owner");
    assert.ok(!tooSmall.ok && tooSmall.issues.some((i) => i.code === "size"));
    const tooBig = validateLayout(base([{ id: "running", widget: "running", x: 0, y: 0, w: 12, h: 5 }]), "owner");
    assert.ok(!tooBig.ok && tooBig.issues.some((i) => i.code === "size"));
  });

  it("refuses unknown widgets, duplicates, bad shapes and too many widgets", () => {
    assert.ok(!validateLayout(base([{ id: "x", widget: "nope" as never, x: 0, y: 0, w: 4, h: 4 }]), "owner").ok);
    const dup = validateLayout(base([
      { id: "a", widget: "inbox", x: 0, y: 0, w: 4, h: 4 },
      { id: "b", widget: "inbox", x: 4, y: 0, w: 4, h: 4 },
    ]), "owner");
    assert.ok(!dup.ok && dup.issues.some((i) => i.code === "duplicate"));
    assert.ok(!validateLayout({ version: 2, widgets: [] }, "owner").ok);
    assert.ok(!validateLayout({ widgets: "x" }, "owner").ok);
    assert.ok(!validateLayout(null, "owner").ok);
    const many = Array.from({ length: MAX_WIDGETS + 1 }, (_, i) => ({ id: `w${i}`, widget: "inbox" as const, x: 0, y: i * 4, w: 4, h: 4 }));
    assert.ok(!validateLayout(base(many), "owner").ok);
  });

  it("an empty desktop is valid", () => {
    assert.ok(validateLayout(base([]), "viewer").ok);
  });
});

describe("editing keeps the grid valid", () => {
  it("moveBy pushes colliding widgets instead of overlapping", () => {
    let l = defaultLayoutFor("owner");
    for (const id of l.widgets.map((w) => w.id)) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [-3, 2], [5, -4]]) {
        l = moveBy(l, id, dx!, dy!);
        assert.ok(validateLayout(l, "owner").ok, `after moving ${id} by ${dx},${dy}`);
      }
    }
  });

  it("moving up past a neighbour swaps rows (↑ always makes progress)", () => {
    const l = defaultLayoutFor("owner");
    const before = l.widgets.find((w) => w.id === "agents")!;
    const after = moveBy(l, "agents", 0, -1).widgets.find((w) => w.id === "agents")!;
    assert.ok(after.y < before.y);
  });

  it("resizeBy clamps to the widget's limits and keeps the grid valid", () => {
    let l = defaultLayoutFor("owner");
    l = resizeBy(l, "briefing", 20, 20);
    const b = l.widgets.find((w) => w.id === "briefing")!;
    assert.equal(b.w, WIDGETS.briefing.maxSize.w);
    assert.equal(b.h, WIDGETS.briefing.maxSize.h);
    assert.ok(validateLayout(l, "owner").ok);
    l = resizeBy(l, "briefing", -20, -20);
    const s = l.widgets.find((w) => w.id === "briefing")!;
    assert.equal(s.w, WIDGETS.briefing.minSize.w);
    assert.equal(s.h, WIDGETS.briefing.minSize.h);
    assert.ok(validateLayout(l, "owner").ok);
  });

  it("add / remove: no duplicates, first free slot, compacts up", () => {
    let l: DesktopLayout = { version: 1, widgets: [] };
    for (const id of WIDGET_IDS) l = addWidget(l, id);
    assert.equal(l.widgets.length, WIDGET_IDS.length);
    assert.ok(validateLayout(l, "owner").ok);
    assert.equal(addWidget(l, "inbox").widgets.length, WIDGET_IDS.length, "adding twice is a no-op");
    const rows = layoutRows(l);
    for (const id of WIDGET_IDS.slice(0, 5)) l = removeWidget(l, id);
    assert.ok(validateLayout(l, "owner").ok);
    assert.ok(layoutRows(l) <= rows);
  });
});

describe("sanitizeLayout (reading a stored layout)", () => {
  it("drops unknown and duplicate widgets, clamps into the grid, settles overlaps", () => {
    const l = sanitizeLayout(
      {
        version: 1,
        widgets: [
          { id: "gone", widget: "retired-widget", x: 0, y: 0, w: 4, h: 4 },
          { id: "cash", widget: "cash", x: 11, y: 0, w: 4, h: 4 },
          { id: "cash2", widget: "cash", x: 0, y: 8, w: 4, h: 4 },
          { id: "inbox", widget: "inbox", x: 9, y: 1, w: 4, h: 4 },
        ],
      },
      "owner",
    );
    assert.deepEqual(l.widgets.map((w) => w.widget).sort(), ["cash", "inbox"]);
    assert.ok(validateLayout(l, "owner").ok);
  });

  it("falls back to the role default when nothing usable is stored", () => {
    assert.deepEqual(sanitizeLayout(null, "editor"), defaultLayoutFor("editor"));
    assert.deepEqual(sanitizeLayout({ widgets: [] }, "editor"), defaultLayoutFor("editor"));
    assert.deepEqual(sanitizeLayout("garbage", "editor"), defaultLayoutFor("editor"));
  });
});

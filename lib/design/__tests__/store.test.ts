// Marketr — Phase 11 "Canvas": design store tests.
// Run: npx tsx --test lib/design/__tests__/store.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { useDesignStore } from "../store";
import { newId, type DesignElement, type RectElement } from "../types";

function reset() {
  useDesignStore.setState({
    document: null,
    activePageId: null,
    selectedIds: [],
    zoom: 1,
    past: [],
    future: [],
    dirty: false,
  });
}

function rect(id: string, x: number, y: number, w = 100, h = 50): RectElement {
  return {
    id,
    type: "rect",
    name: id,
    x,
    y,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    width: w,
    height: h,
    fill: "#7c3aed",
    cornerRadius: 0,
  };
}

function freshDoc() {
  reset();
  const s = useDesignStore.getState();
  s.newDocument(1080, 1080, "#FAFAF7");
  return useDesignStore.getState();
}

function activePage() {
  const s = useDesignStore.getState();
  const doc = s.document!;
  return doc.pages.find((p) => p.id === s.activePageId)!;
}

beforeEach(reset);

describe("newDocument / loadDocument", () => {
  it("newDocument creates one page, sets active page, marks dirty", () => {
    const s = freshDoc();
    assert.equal(s.document!.pages.length, 1);
    assert.equal(s.activePageId, s.document!.pages[0]!.id);
    assert.equal(s.dirty, true);
    assert.equal(s.canUndo(), false);
  });

  it("loadDocument resets history and selection", () => {
    const s = freshDoc();
    s.addElement(rect("a", 0, 0));
    assert.equal(s.canUndo(), true);
    s.loadDocument(s.document!);
    const s2 = useDesignStore.getState();
    assert.equal(s2.canUndo(), false);
    assert.equal(s2.dirty, false);
    assert.deepEqual(s2.selectedIds, []);
  });
});

describe("elements", () => {
  it("addElement adds to the active page and selects it", () => {
    freshDoc();
    const el = rect("a", 10, 20);
    useDesignStore.getState().addElement(el);
    const s = useDesignStore.getState();
    assert.equal(activePage().elements.length, 1);
    assert.deepEqual(s.selectedIds, ["a"]);
    assert.equal(s.dirty, true);
  });

  it("updateElement patches fields immutably", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 10, 20));
    const before = activePage().elements[0]!;
    s.updateElement("a", { x: 99, fill: "#ff0000" });
    const after = activePage().elements[0]!;
    assert.notEqual(before, after); // new object
    assert.equal(after.x, 99);
    assert.equal((after as RectElement).fill, "#ff0000");
    assert.equal(after.y, 20); // untouched fields survive
  });

  it("removeElements removes and deselects", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 0, 0));
    s.addElement(rect("b", 0, 0));
    useDesignStore.getState().select(["a", "b"]);
    useDesignStore.getState().removeElements(["a"]);
    const s2 = useDesignStore.getState();
    assert.deepEqual(
      activePage().elements.map((e) => e.id),
      ["b"],
    );
    assert.deepEqual(s2.selectedIds, ["b"]);
  });

  it("duplicateElements copies with new ids, offset position, selects copies", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 10, 20));
    s.duplicateElements(["a"]);
    const s2 = useDesignStore.getState();
    const els = activePage().elements;
    assert.equal(els.length, 2);
    assert.notEqual(els[0]!.id, els[1]!.id);
    assert.equal(els[1]!.x, 26);
    assert.equal(els[1]!.y, 36);
    assert.deepEqual(s2.selectedIds, [els[1]!.id]);
  });
});

describe("z-order moves", () => {
  function three() {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 0, 0));
    s.addElement(rect("b", 0, 0));
    s.addElement(rect("c", 0, 0));
  }
  const order = () => activePage().elements.map((e) => e.id);

  it("moveElement front moves to the top", () => {
    three();
    useDesignStore.getState().moveElement("a", "front");
    assert.deepEqual(order(), ["b", "c", "a"]);
  });

  it("moveElement back moves to the bottom", () => {
    three();
    useDesignStore.getState().moveElement("c", "back");
    assert.deepEqual(order(), ["c", "a", "b"]);
  });

  it("moveElement forward/backward swaps one step", () => {
    three();
    useDesignStore.getState().moveElement("b", "forward");
    assert.deepEqual(order(), ["a", "c", "b"]);
    useDesignStore.getState().moveElement("b", "backward");
    assert.deepEqual(order(), ["a", "b", "c"]);
  });

  it("moves at the edges are no-ops but safe", () => {
    three();
    useDesignStore.getState().moveElement("a", "backward");
    useDesignStore.getState().moveElement("c", "forward");
    assert.deepEqual(order(), ["a", "b", "c"]);
  });
});

describe("undo / redo", () => {
  it("undo restores the previous document, redo re-applies", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 0, 0));
    assert.equal(useDesignStore.getState().canUndo(), true);
    assert.equal(useDesignStore.getState().canRedo(), false);

    useDesignStore.getState().undo();
    assert.equal(activePage().elements.length, 0);
    assert.equal(useDesignStore.getState().canUndo(), false);
    assert.equal(useDesignStore.getState().canRedo(), true);

    useDesignStore.getState().redo();
    assert.deepEqual(
      activePage().elements.map((e) => e.id),
      ["a"],
    );
    assert.equal(useDesignStore.getState().canRedo(), false);
  });

  it("a new action clears the redo stack", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 0, 0));
    useDesignStore.getState().undo();
    useDesignStore.getState().addElement(rect("b", 0, 0));
    assert.equal(useDesignStore.getState().canRedo(), false);
    assert.deepEqual(
      activePage().elements.map((e) => e.id),
      ["b"],
    );
  });

  it("history is capped at 50 snapshots", () => {
    freshDoc();
    const s = useDesignStore.getState();
    for (let i = 0; i < 55; i++) {
      useDesignStore.getState().addElement(rect(`e${i}`, i, 0));
    }
    assert.equal(useDesignStore.getState().past.length, 50);
    // still undoes correctly at the cap
    useDesignStore.getState().undo();
    assert.equal(activePage().elements.length, 54);
  });

  it("select/zoom do not push history", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 0, 0));
    const depth = useDesignStore.getState().past.length;
    useDesignStore.getState().select(["a"]);
    useDesignStore.getState().setZoom(2);
    assert.equal(useDesignStore.getState().past.length, depth);
  });

  it("markClean clears the dirty flag", () => {
    freshDoc();
    useDesignStore.getState().markClean();
    assert.equal(useDesignStore.getState().dirty, false);
  });
});

describe("page ops", () => {
  it("addPage appends and activates the new page", () => {
    freshDoc();
    useDesignStore.getState().addPage();
    const s = useDesignStore.getState();
    assert.equal(s.document!.pages.length, 2);
    assert.equal(s.activePageId, s.document!.pages[1]!.id);
    assert.equal(s.document!.pages[1]!.name, "Page 2");
  });

  it("duplicatePage copies elements with fresh ids", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 5, 5));
    const srcId = s.activePageId!;
    useDesignStore.getState().duplicatePage(srcId);
    const s2 = useDesignStore.getState();
    assert.equal(s2.document!.pages.length, 2);
    const copy = s2.document!.pages[1]!;
    assert.match(copy.name, /copy/);
    assert.equal(copy.elements.length, 1);
    assert.notEqual(copy.elements[0]!.id, "a");
    assert.equal(copy.elements[0]!.x, 5);
    assert.equal(s2.activePageId, copy.id);
  });

  it("cannot remove the last page", () => {
    freshDoc();
    const s = useDesignStore.getState();
    const onlyId = s.activePageId!;
    s.removePage(onlyId);
    assert.equal(useDesignStore.getState().document!.pages.length, 1);
    assert.equal(useDesignStore.getState().canUndo(), false);
  });

  it("removePage drops the page and re-targets the active page", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.addPage();
    const secondId = useDesignStore.getState().activePageId!;
    useDesignStore.getState().removePage(secondId);
    const s2 = useDesignStore.getState();
    assert.equal(s2.document!.pages.length, 1);
    assert.equal(s2.activePageId, s2.document!.pages[0]!.id);
  });

  it("renamePage / setPageBackground / setPageSize patch the page", () => {
    freshDoc();
    const s = useDesignStore.getState();
    const id = s.activePageId!;
    s.renamePage(id, "Cover");
    s.setPageBackground(id, "#000000");
    s.setPageSize(id, 1920, 1080);
    const p = useDesignStore.getState().document!.pages[0]!;
    assert.equal(p.name, "Cover");
    assert.equal(p.background, "#000000");
    assert.equal(p.width, 1920);
    assert.equal(p.height, 1080);
  });

  it("setActivePage switches pages and clears selection", () => {
    freshDoc();
    const s = useDesignStore.getState();
    const firstId = s.activePageId!;
    s.addPage();
    useDesignStore.getState().select(["x"]);
    useDesignStore.getState().setActivePage(firstId);
    const s2 = useDesignStore.getState();
    assert.equal(s2.activePageId, firstId);
    assert.deepEqual(s2.selectedIds, []);
  });
});

describe("alignment", () => {
  function twoRects() {
    freshDoc();
    const s = useDesignStore.getState();
    s.addElement(rect("a", 10, 20, 100, 50));
    s.addElement(rect("b", 300, 400, 100, 50));
  }

  it("align left snaps all to the min x", () => {
    twoRects();
    useDesignStore.getState().alignElements(["a", "b"], "left");
    const els = activePage().elements;
    assert.equal(els[0]!.x, 10);
    assert.equal(els[1]!.x, 10);
  });

  it("align right snaps all to the max right edge", () => {
    twoRects();
    useDesignStore.getState().alignElements(["a", "b"], "right");
    const els = activePage().elements;
    assert.equal(els[0]!.x, 300);
    assert.equal(els[1]!.x, 300);
  });

  it("align center-x centers on the selection midpoint", () => {
    twoRects();
    useDesignStore.getState().alignElements(["a", "b"], "center-x");
    const els = activePage().elements;
    // selection spans x=10..400, midpoint 205; each 100 wide → x=155
    assert.equal(els[0]!.x, 155);
    assert.equal(els[1]!.x, 155);
  });

  it("align top / center-y / bottom work on y", () => {
    twoRects();
    useDesignStore.getState().alignElements(["a", "b"], "top");
    let els = activePage().elements;
    assert.equal(els[0]!.y, 20);
    assert.equal(els[1]!.y, 20);

    twoRects();
    useDesignStore.getState().alignElements(["a", "b"], "center-y");
    els = activePage().elements;
    // selection spans y=20..450, midpoint 235; each 50 tall → y=210
    assert.equal(els[0]!.y, 210);
    assert.equal(els[1]!.y, 210);

    twoRects();
    useDesignStore.getState().alignElements(["a", "b"], "bottom");
    els = activePage().elements;
    assert.equal(els[0]!.y, 400);
    assert.equal(els[1]!.y, 400);
  });

  it("align with fewer than two valid elements is a no-op", () => {
    twoRects();
    const depth = useDesignStore.getState().past.length;
    useDesignStore.getState().alignElements(["a"], "left");
    assert.equal(activePage().elements[0]!.x, 10);
    assert.equal(useDesignStore.getState().past.length, depth); // no history pushed
  });
});

describe("selection and zoom", () => {
  it("select replaces, additive merges", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.select(["a"]);
    assert.deepEqual(useDesignStore.getState().selectedIds, ["a"]);
    useDesignStore.getState().select(["b"], true);
    assert.deepEqual(useDesignStore.getState().selectedIds, ["a", "b"]);
    useDesignStore.getState().select(["c"]);
    assert.deepEqual(useDesignStore.getState().selectedIds, ["c"]);
  });

  it("clearSelection empties the selection", () => {
    freshDoc();
    useDesignStore.getState().select(["a", "b"]);
    useDesignStore.getState().clearSelection();
    assert.deepEqual(useDesignStore.getState().selectedIds, []);
  });

  it("setZoom clamps to 0.1..4", () => {
    freshDoc();
    const s = useDesignStore.getState();
    s.setZoom(2.5);
    assert.equal(useDesignStore.getState().zoom, 2.5);
    s.setZoom(0.01);
    assert.equal(useDesignStore.getState().zoom, 0.1);
    s.setZoom(99);
    assert.equal(useDesignStore.getState().zoom, 4);
  });
});

describe("immutability", () => {
  it("mutations never reuse the prior document object", () => {
    freshDoc();
    const before = useDesignStore.getState().document!;
    useDesignStore.getState().addElement(rect("a", 0, 0));
    const after = useDesignStore.getState().document!;
    assert.notEqual(before, after);
    assert.equal(before.pages[0]!.elements.length, 0); // untouched snapshot
    assert.equal(after.pages[0]!.elements.length, 1);
  });

  it("newId generates unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    assert.equal(ids.size, 100);
  });
});

// Marketr — Phase 11 "Canvas" FEATURE 1 (richer text) tests.
// Run: npx tsx --test lib/design/__tests__/rich-text.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  TEXT_PATH_PRESETS,
  applyFragmentStyle,
  baseStyleOf,
  concatFragments,
  hasRichFragments,
  layoutRichText,
  rangeHasFlag,
  rangeUniformStyle,
  resolveFragment,
  toggleFragmentFlag,
  type FragmentBaseStyle,
  type LayoutBase,
  type MeasureFn,
} from "../rich-text";
import { useDesignStore } from "../store";
import { validateDesignDocument } from "../validate";
import type { TextElement, TextFragment } from "../types";

const BASE: FragmentBaseStyle = {
  fontFamily: "Inter",
  fontSize: 20,
  fontStyle: "normal",
  fill: "#1c1917",
};

const LAYOUT_BASE: LayoutBase = {
  ...BASE,
  lineHeight: 1.25,
  letterSpacing: 0,
  align: "left",
};

/** Deterministic stub: every char is half the font size wide. */
const stubMeasure: MeasureFn = (text, style) => text.length * style.fontSize * 0.5;

describe("fragment model", () => {
  it("applies a style to a range and keeps text in sync", () => {
    const res = applyFragmentStyle([], "Hello world", 0, 5, { fontStyle: "bold" }, BASE);
    assert.ok(res);
    assert.deepEqual(res.fragments, [
      { text: "Hello", fontStyle: "bold" },
      { text: " world" },
    ]);
    assert.equal(res.text, "Hello world");
    assert.equal(concatFragments(res.fragments), res.text);
  });

  it("resolves omitted style fields against the element base", () => {
    const res = applyFragmentStyle([], "ab", 0, 2, { fill: "#f00" }, BASE);
    assert.ok(res);
    const r = resolveFragment(BASE, res.fragments[0]!);
    assert.equal(r.fill, "#f00");
    assert.equal(r.fontFamily, "Inter");
    assert.equal(r.fontSize, 20);
    assert.equal(r.fontStyle, "normal");
  });

  it("merges adjacent runs with identical style", () => {
    const first = applyFragmentStyle([], "Hello world", 0, 5, { fontStyle: "bold" }, BASE);
    assert.ok(first);
    const second = applyFragmentStyle(
      first.fragments,
      first.text,
      5,
      11,
      { fontStyle: "bold" },
      BASE,
    );
    assert.ok(second);
    assert.deepEqual(second.fragments, [{ text: "Hello world", fontStyle: "bold" }]);
  });

  it("splits around the range, preserving outside styles", () => {
    const res = applyFragmentStyle([], "abcdef", 2, 4, { fontStyle: "italic" }, BASE);
    assert.ok(res);
    assert.deepEqual(res.fragments, [
      { text: "ab" },
      { text: "cd", fontStyle: "italic" },
      { text: "ef" },
    ]);
  });

  it("returns null for empty ranges and clamps out-of-bounds ranges", () => {
    assert.equal(applyFragmentStyle([], "abc", 2, 2, { fontStyle: "bold" }, BASE), null);
    assert.equal(applyFragmentStyle([], "abc", 5, 9, { fontStyle: "bold" }, BASE), null);
    assert.equal(applyFragmentStyle([], "", 0, 1, { fontStyle: "bold" }, BASE), null);
    const clamped = applyFragmentStyle([], "abc", -50, 500, { fontStyle: "bold" }, BASE);
    assert.ok(clamped);
    assert.deepEqual(clamped.fragments, [{ text: "abc", fontStyle: "bold" }]);
  });

  it("returns null when the style changes nothing (no-op)", () => {
    // Styling with the base values is a no-op.
    assert.equal(
      applyFragmentStyle([], "abc", 0, 3, { fontStyle: "normal", fill: "#1c1917" }, BASE),
      null,
    );
    // Applying the already-present style is a no-op.
    const first = applyFragmentStyle([], "abc", 0, 3, { fontStyle: "bold" }, BASE);
    assert.ok(first);
    assert.equal(
      applyFragmentStyle(first.fragments, first.text, 0, 3, { fontStyle: "bold" }, BASE),
      null,
    );
    // Empty style object is a no-op.
    assert.equal(applyFragmentStyle([], "abc", 0, 3, {}, BASE), null);
  });

  it("self-heals when fragments do not concatenate to the text", () => {
    const res = applyFragmentStyle(
      [{ text: "stale" }],
      "fresh",
      0,
      5,
      { fontStyle: "bold" },
      BASE,
    );
    assert.ok(res);
    assert.equal(res.text, "fresh");
    assert.deepEqual(res.fragments, [{ text: "fresh", fontStyle: "bold" }]);
  });

  it("toggles bold/italic per fragment, preserving the other flag", () => {
    const on = toggleFragmentFlag([], "abc", 0, 3, "bold", BASE);
    assert.ok(on);
    assert.deepEqual(on.fragments, [{ text: "abc", fontStyle: "bold" }]);

    const off = toggleFragmentFlag(on.fragments, on.text, 0, 3, "bold", BASE);
    assert.ok(off);
    assert.equal(off.text, "abc");
    assert.deepEqual(off.fragments, [{ text: "abc" }]);

    // Toggling bold onto italic text yields bold-italic, not a replacement.
    const italicBase: FragmentBaseStyle = { ...BASE, fontStyle: "italic" };
    const both = toggleFragmentFlag([], "abc", 0, 3, "bold", italicBase);
    assert.ok(both);
    assert.deepEqual(both.fragments, [{ text: "abc", fontStyle: "bold-italic" }]);
    const backToItalic = toggleFragmentFlag(both.fragments, both.text, 0, 3, "bold", italicBase);
    assert.ok(backToItalic);
    assert.deepEqual(backToItalic.fragments, [{ text: "abc" }]);
  });

  it("rangeHasFlag reports per-range flag state", () => {
    const frags: TextFragment[] = [
      { text: "ab", fontStyle: "bold" },
      { text: "cd" },
    ];
    assert.equal(rangeHasFlag(frags, "abcd", 0, 2, "bold", BASE), true);
    assert.equal(rangeHasFlag(frags, "abcd", 0, 4, "bold", BASE), false);
    assert.equal(rangeHasFlag(frags, "abcd", 2, 4, "bold", BASE), false);
    assert.equal(rangeHasFlag(frags, "abcd", 0, 0, "bold", BASE), false);
  });

  it("rangeUniformStyle returns only uniform fields", () => {
    const frags: TextFragment[] = [
      { text: "ab", fill: "#f00" },
      { text: "cd", fill: "#f00" },
    ];
    const uniform = rangeUniformStyle(frags, "abcd", 0, 4, BASE);
    assert.equal(uniform.fill, "#f00");
    assert.equal(uniform.fontFamily, "Inter");
    const mixed: TextFragment[] = [
      { text: "ab", fill: "#f00" },
      { text: "cd", fill: "#0f0" },
    ];
    const partial = rangeUniformStyle(mixed, "abcd", 0, 4, BASE);
    assert.equal(partial.fill, undefined);
    assert.equal(partial.fontFamily, "Inter");
  });

  it("hasRichFragments follows the schema contract", () => {
    const plain: TextElement = makeTextEl("t1");
    assert.equal(hasRichFragments(plain), false);
    assert.equal(hasRichFragments({ ...plain, fragments: [] }), false);
    assert.equal(hasRichFragments({ ...plain, fragments: [{ text: "" }] }), false);
    assert.equal(hasRichFragments({ ...plain, fragments: [{ text: "x" }] }), true);
  });
});

describe("manual rich-text layout", () => {
  it("lays out per-fragment runs with x offsets", () => {
    const runs = layoutRichText({
      fragments: [{ text: "Hello " }, { text: "world", fill: "#f00" }],
      base: LAYOUT_BASE,
      measure: stubMeasure,
    });
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.text, "Hello ");
    assert.equal(runs[0]!.x, 0);
    assert.equal(runs[0]!.y, 0);
    assert.equal(runs[1]!.text, "world");
    assert.equal(runs[1]!.x, 60); // 6 chars * 20 * 0.5
    assert.equal(runs[1]!.y, 0);
    assert.equal(runs[1]!.fill, "#f00");
    assert.equal(runs[1]!.fontStyle, "normal");
  });

  it("wraps at the wrap width like Konva wrap='word'", () => {
    const runs = layoutRichText({
      fragments: [{ text: "aaa bbb ccc" }],
      base: { ...LAYOUT_BASE, width: 100 },
      measure: stubMeasure,
    });
    // "aaa bbb " on line 1 (80px), "ccc" wraps to line 2.
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.text, "aaa bbb ");
    assert.equal(runs[0]!.x, 0);
    assert.equal(runs[0]!.y, 0);
    assert.equal(runs[1]!.text, "ccc");
    assert.equal(runs[1]!.x, 0);
    assert.equal(runs[1]!.y, 25); // 20 * 1.25
  });

  it("an overlong word overflows its line instead of vanishing", () => {
    const runs = layoutRichText({
      fragments: [{ text: "supercalifragilistic" }],
      base: { ...LAYOUT_BASE, width: 50 },
      measure: stubMeasure,
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.text, "supercalifragilistic");
    assert.equal(runs[0]!.x, 0);
  });

  it("applies center/right alignment per line", () => {
    const base = { ...LAYOUT_BASE, width: 100 };
    const centered = layoutRichText({
      fragments: [{ text: "aaa bbb ccc" }],
      base: { ...base, align: "center" },
      measure: stubMeasure,
    });
    assert.equal(centered[0]!.x, 10); // (100-80)/2
    assert.equal(centered[1]!.x, 35); // (100-30)/2
    const right = layoutRichText({
      fragments: [{ text: "aaa bbb ccc" }],
      base: { ...base, align: "right" },
      measure: stubMeasure,
    });
    assert.equal(right[0]!.x, 20);
    assert.equal(right[1]!.x, 70);
  });

  it("honors explicit newlines", () => {
    const runs = layoutRichText({
      fragments: [{ text: "a\nb" }],
      base: LAYOUT_BASE,
      measure: stubMeasure,
    });
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.y, 0);
    assert.equal(runs[1]!.y, 25);
  });

  it("resolves per-fragment font size and style", () => {
    const runs = layoutRichText({
      fragments: [{ text: "big", fontSize: 40, fontStyle: "bold-italic" }],
      base: LAYOUT_BASE,
      measure: stubMeasure,
    });
    assert.equal(runs[0]!.fontSize, 40);
    assert.equal(runs[0]!.fontStyle, "bold italic");
  });

  it("returns no runs for empty fragments", () => {
    assert.deepEqual(
      layoutRichText({ fragments: [], base: LAYOUT_BASE, measure: stubMeasure }),
      [],
    );
    assert.deepEqual(
      layoutRichText({ fragments: [{ text: "" }], base: LAYOUT_BASE, measure: stubMeasure }),
      [],
    );
  });
});

describe("text path presets", () => {
  it("ships arc, wave, and circle presets with usable path data", () => {
    assert.equal(TEXT_PATH_PRESETS.length, 3);
    assert.deepEqual(
      TEXT_PATH_PRESETS.map((p) => p.key),
      ["arc", "wave", "circle"],
    );
    for (const p of TEXT_PATH_PRESETS) {
      assert.ok(p.data.trim().startsWith("M"), `${p.key} should start with a moveto`);
    }
  });
});

// ── Validator ────────────────────────────────────────────────────────────

function textEl(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    type: "text",
    name: "T",
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    text: "hi",
    fontFamily: "Inter",
    fontSize: 20,
    fontStyle: "normal",
    fill: "#1c1917",
    align: "left",
    lineHeight: 1.25,
    letterSpacing: 0,
    ...over,
  };
}

function docWith(el: unknown): unknown {
  return {
    schemaVersion: 1,
    pages: [
      {
        id: "p1",
        name: "P",
        width: 100,
        height: 100,
        background: "#ffffff",
        elements: [el],
      },
    ],
  };
}

describe("validator: fragments and textPath", () => {
  it("accepts fragments and textPath", () => {
    const res = validateDesignDocument(
      docWith(
        textEl({
          fragments: [
            { text: "hi", fontStyle: "bold", fontSize: 24, fill: "#f00", fontFamily: "Arial" },
            { text: " there" },
          ],
          textPath: "M 0 70 Q 160 0 320 70",
        }),
      ),
    );
    assert.equal(res.ok, true);
  });

  it("stays backwards compatible without fragments/textPath", () => {
    assert.equal(validateDesignDocument(docWith(textEl())).ok, true);
  });

  it("rejects malformed fragments", () => {
    const notArray = validateDesignDocument(docWith(textEl({ fragments: "nope" })));
    assert.equal(notArray.ok, false);
    if (!notArray.ok) assert.match(notArray.error, /fragments/);
    const badText = validateDesignDocument(docWith(textEl({ fragments: [{ text: 5 }] })));
    assert.equal(badText.ok, false);
    if (!badText.ok) assert.match(badText.error, /fragments\[0\]\.text/);
    const badSize = validateDesignDocument(
      docWith(textEl({ fragments: [{ text: "x", fontSize: -1 }] })),
    );
    assert.equal(badSize.ok, false);
    if (!badSize.ok) assert.match(badSize.error, /fontSize/);
  });

  it("rejects a non-string textPath", () => {
    const res = validateDesignDocument(docWith(textEl({ textPath: 42 })));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /textPath/);
  });
});

// ── Store actions ────────────────────────────────────────────────────────

function makeTextEl(id: string): TextElement {
  return {
    id,
    type: "text",
    name: id,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    text: "Hello world",
    fontFamily: "Inter",
    fontSize: 20,
    fontStyle: "normal",
    fill: "#1c1917",
    align: "left",
    lineHeight: 1.25,
    letterSpacing: 0,
    width: 400,
  };
}

function resetStore() {
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

function setupText(id = "t1"): TextElement {
  resetStore();
  const s = useDesignStore.getState();
  s.newDocument(800, 600);
  s.addElement(makeTextEl(id));
  return useDesignStore
    .getState()
    .document!.pages[0]!.elements.find((e) => e.id === id)! as TextElement;
}

function getText(id: string): TextElement {
  return useDesignStore
    .getState()
    .document!.pages[0]!.elements.find((e) => e.id === id)! as TextElement;
}

describe("store: rich-text actions", () => {
  beforeEach(() => resetStore());

  it("applyFragmentStyle builds fragments, keeps text synced, and is undoable", () => {
    setupText();
    const before = useDesignStore.getState().past.length;
    useDesignStore.getState().applyFragmentStyle("t1", 0, 5, { fontStyle: "bold" });
    const el = getText("t1");
    assert.ok(el.fragments);
    assert.equal(el.fragments.length, 2);
    assert.equal(el.fragments[0]!.fontStyle, "bold");
    assert.equal(el.text, "Hello world");
    assert.equal(concatFragments(el.fragments), el.text);
    assert.equal(useDesignStore.getState().past.length, before + 1);

    useDesignStore.getState().undo();
    assert.equal(getText("t1").fragments, undefined);
    useDesignStore.getState().redo();
    assert.equal(getText("t1").fragments!.length, 2);
  });

  it("applyFragmentStyle is a no-op for empty ranges and unknown elements", () => {
    setupText();
    const s = useDesignStore.getState();
    const pastLen = s.past.length;
    s.applyFragmentStyle("t1", 3, 3, { fontStyle: "bold" });
    s.applyFragmentStyle("missing", 0, 3, { fontStyle: "bold" });
    assert.equal(getText("t1").fragments, undefined);
    assert.equal(useDesignStore.getState().past.length, pastLen);
  });

  it("clearFragments drops styling and is undoable; no-op when plain", () => {
    setupText();
    const s = useDesignStore.getState();
    s.applyFragmentStyle("t1", 0, 5, { fontStyle: "bold" });
    assert.ok(getText("t1").fragments);
    const pastLen = useDesignStore.getState().past.length;
    useDesignStore.getState().clearFragments("t1");
    assert.equal(getText("t1").fragments, undefined);
    assert.equal(getText("t1").text, "Hello world");
    assert.equal(useDesignStore.getState().past.length, pastLen + 1);
    useDesignStore.getState().undo();
    assert.ok(getText("t1").fragments);

    // No-op when there is nothing to clear.
    useDesignStore.getState().clearFragments("t1");
    const after = useDesignStore.getState().past.length;
    useDesignStore.getState().clearFragments("t1");
    assert.equal(useDesignStore.getState().past.length, after);
  });

  it("setTextPath sets, clears, and ignores unchanged values", () => {
    setupText();
    const s = useDesignStore.getState();
    const pastLen = s.past.length;
    s.setTextPath("t1", "M 0 70 Q 160 0 320 70");
    assert.equal(getText("t1").textPath, "M 0 70 Q 160 0 320 70");
    assert.equal(useDesignStore.getState().past.length, pastLen + 1);
    // Same value: no history entry.
    s.setTextPath("t1", "M 0 70 Q 160 0 320 70");
    assert.equal(useDesignStore.getState().past.length, pastLen + 1);
    // Blank clears.
    s.setTextPath("t1", "  ");
    assert.equal(getText("t1").textPath, undefined);
    s.setTextPath("t1");
    assert.equal(useDesignStore.getState().past.length, pastLen + 2);
    // Undo restores the path.
    useDesignStore.getState().undo();
    assert.equal(getText("t1").textPath, "M 0 70 Q 160 0 320 70");
  });

  it("updateElement drops stale fragments on wholesale text replacement", () => {
    setupText();
    const s = useDesignStore.getState();
    s.applyFragmentStyle("t1", 0, 5, { fontStyle: "bold" });
    assert.ok(getText("t1").fragments);
    s.updateElement("t1", { text: "Brand new" });
    const el = getText("t1");
    assert.equal(el.text, "Brand new");
    assert.equal(el.fragments, undefined);
  });

  it("updateElement keeps fragments when patching style fields", () => {
    setupText();
    const s = useDesignStore.getState();
    s.applyFragmentStyle("t1", 0, 5, { fontStyle: "bold" });
    s.updateElement("t1", { fill: "#7c3aed" });
    const el = getText("t1");
    assert.ok(el.fragments);
    assert.equal(el.fill, "#7c3aed");
  });

  it("baseStyleOf reads the element's own style fields", () => {
    const el = makeTextEl("t1");
    assert.deepEqual(baseStyleOf(el), BASE);
  });
});

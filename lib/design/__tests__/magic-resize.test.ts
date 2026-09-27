// Marketr — Phase 11 "Canvas": magic-resize scaling-math tests.
// Run: npx tsx --test lib/design/__tests__/magic-resize.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scalePage, scaleElement, scaleSvgPathData } from "../magic-resize";
import type {
  ChartElement,
  DesignPage,
  EllipseElement,
  ImageElement,
  LineElement,
  QrElement,
  RectElement,
  SvgElement,
  TextElement,
} from "../types";

function page(elements: DesignPage["elements"], w = 1080, h = 1080): DesignPage {
  return {
    id: "page-1",
    name: "Page 1",
    width: w,
    height: h,
    background: "#FAFAF7",
    elements,
  };
}

function rect(id: string, x: number, y: number, w: number, h: number): RectElement {
  return {
    id, type: "rect", name: id, x, y, rotation: 0, opacity: 1,
    visible: true, locked: false, width: w, height: h,
    fill: "#000", cornerRadius: 8,
  };
}

function text(id: string, x: number, y: number, fontSize: number, width?: number): TextElement {
  return {
    id, type: "text", name: id, x, y, rotation: 0, opacity: 1,
    visible: true, locked: false, text: "hello", fontFamily: "Inter",
    fontSize, fontStyle: "normal", fill: "#000", align: "left",
    lineHeight: 1.2, letterSpacing: 0, width,
  };
}

describe("scalePage — uniform scale", () => {
  it("doubles positions and sizes on a 2x resize", () => {
    const p = page([rect("r", 100, 50, 200, 100)]);
    const out = scalePage(p, 2160, 2160);
    assert.equal(out.width, 2160);
    assert.equal(out.height, 2160);
    const r = out.elements[0] as RectElement;
    assert.deepEqual([r.x, r.y, r.width, r.height], [200, 100, 400, 200]);
    assert.equal(r.cornerRadius, 16);
  });

  it("scales fontSize exactly on uniform resize", () => {
    const p = page([text("t", 10, 20, 24, 300)]);
    const out = scalePage(p, 2160, 2160);
    const t = out.elements[0] as TextElement;
    assert.equal(t.fontSize, 48);
    assert.equal(t.width, 600);
    assert.deepEqual([t.x, t.y], [20, 40]);
  });

  it("leaves text without a wrap width alone", () => {
    const p = page([text("t", 0, 0, 16)]);
    const out = scalePage(p, 2160, 2160);
    const t = out.elements[0] as TextElement;
    assert.equal(t.width, undefined);
    assert.equal(t.fontSize, 32);
  });
});

describe("scalePage — non-uniform scale", () => {
  it("scales x/y independently (square → story)", () => {
    const p = page([rect("r", 100, 100, 200, 200)]);
    const out = scalePage(p, 1080, 1920);
    const r = out.elements[0] as RectElement;
    // sx = 1, sy = 1920/1080 ≈ 1.777…
    assert.equal(r.x, 100);
    assert.equal(r.width, 200);
    assert.ok(Math.abs(r.y - 177.78) < 0.01);
    assert.ok(Math.abs(r.height - 355.56) < 0.01);
  });

  it("scales fontSize by the smaller axis on non-uniform resize", () => {
    // Square → story: sx=1, sy>1, so font stays put (fits the wrap box).
    const p = page([text("t", 0, 0, 24, 400)]);
    const out = scalePage(p, 1080, 1920);
    const t = out.elements[0] as TextElement;
    assert.equal(t.fontSize, 24);
    assert.equal(t.width, 400); // wrap width follows sx only
  });

  it("shrinks fontSize by the smaller axis when only one axis shrinks", () => {
    // 1920×1080 → 1080×1080: sx=0.5625, sy=1
    const p = page([text("t", 0, 0, 32)], 1920, 1080);
    const out = scalePage(p, 1080, 1080);
    const t = out.elements[0] as TextElement;
    assert.equal(t.fontSize, 18); // 32 * 0.5625 = 18 exactly
  });
});

describe("fontSize rounding", () => {
  it("rounds to the nearest 0.5pt", () => {
    const t = text("t", 0, 0, 15);
    const scaled = scaleElement(t, 1.5, 1.5) as TextElement;
    assert.equal(scaled.fontSize, 22.5); // 15 * 1.5
  });

  it("rounds awkward fractions to halves", () => {
    const t = text("t", 0, 0, 10);
    const scaled = scaleElement(t, 1.33, 1.33) as TextElement;
    assert.equal(scaled.fontSize, 13.5); // 13.3 → 13.5
  });

  it("scales per-fragment fontSize overrides too", () => {
    const t: TextElement = {
      ...text("t", 0, 0, 20),
      fragments: [{ text: "a", fontSize: 12 }, { text: "b" }],
    };
    const scaled = scaleElement(t, 2, 2) as TextElement;
    assert.equal(scaled.fontSize, 40);
    assert.equal(scaled.fragments![0]!.fontSize, 24);
    assert.equal(scaled.fragments![1]!.fontSize, undefined);
  });
});

describe("per-type scaling", () => {
  it("scales line points in element-local coords (even=sx, odd=sy)", () => {
    const line: LineElement = {
      id: "l", type: "line", name: "l", x: 10, y: 20, rotation: 0,
      opacity: 1, visible: true, locked: false,
      points: [0, 0, 100, 50, 200, 100], stroke: "#000", strokeWidth: 2,
      dash: [4, 2],
    };
    const out = scaleElement(line, 2, 3) as LineElement;
    assert.deepEqual(out.points, [0, 0, 200, 150, 400, 300]);
    assert.deepEqual([out.x, out.y], [20, 60]);
    assert.equal(out.strokeWidth, 2); // cosmetic constants are not scaled
    assert.deepEqual(out.dash, [4, 2]);
  });

  it("scales ellipse radii independently", () => {
    const e: EllipseElement = {
      id: "e", type: "ellipse", name: "e", x: 50, y: 50, rotation: 0,
      opacity: 1, visible: true, locked: false, radiusX: 40, radiusY: 20, fill: "#000",
    };
    const out = scaleElement(e, 2, 3) as EllipseElement;
    assert.deepEqual([out.radiusX, out.radiusY], [80, 60]);
  });

  it("scales QR size by the smaller axis", () => {
    const q: QrElement = {
      id: "q", type: "qr", name: "q", x: 10, y: 10, rotation: 0,
      opacity: 1, visible: true, locked: false, payload: "https://x.co",
      size: 120, foreground: "#000", background: "#fff",
    };
    const out = scaleElement(q, 2, 3) as QrElement;
    assert.equal(out.size, 240); // min(2,3) * 120
  });

  it("scales image dimensions and corner radius", () => {
    const img: ImageElement = {
      id: "i", type: "image", name: "i", x: 10, y: 20, rotation: 0,
      opacity: 1, visible: true, locked: false, src: "x.png",
      width: 100, height: 50, cornerRadius: 10,
    };
    const out = scaleElement(img, 2, 2) as ImageElement;
    assert.deepEqual([out.width, out.height, out.cornerRadius], [200, 100, 20]);
  });

  it("scales svg width/height", () => {
    const s: SvgElement = {
      id: "s", type: "svg", name: "s", x: 5, y: 5, rotation: 0,
      opacity: 1, visible: true, locked: false, path: "M0 0 L10 10",
      width: 24, height: 24, fill: "#000",
    };
    const out = scaleElement(s, 1.5, 2) as SvgElement;
    assert.deepEqual([out.width, out.height], [36, 48]);
    assert.equal(out.path, "M0 0 L10 10"); // icon path data is viewBox-local, not scaled
  });

  it("moves chart elements but leaves their data alone (no size fields in schema)", () => {
    const c: ChartElement = {
      id: "c", type: "chart", name: "c", x: 10, y: 20, rotation: 0,
      opacity: 1, visible: true, locked: false, chartType: "bar",
      labels: ["a"], values: [1], colors: ["#000"], showValues: true,
    };
    const out = scaleElement(c, 2, 3) as ChartElement;
    assert.deepEqual([out.x, out.y], [20, 60]);
    assert.deepEqual(out.values, [1]);
  });
});

describe("preserved and proportional placement", () => {
  it("preserves rotation, lock, and visibility", () => {
    const r = { ...rect("r", 10, 10, 20, 20), rotation: 45, locked: true, visible: false };
    const out = scalePage(page([r]), 2160, 2160).elements[0] as RectElement;
    assert.equal(out.rotation, 45);
    assert.equal(out.locked, true);
    assert.equal(out.visible, false);
  });

  it("keeps off-page elements proportionally placed (no clipping)", () => {
    const r = rect("r", -200, -100, 100, 100);
    const out = scalePage(page([r]), 2160, 2160).elements[0] as RectElement;
    assert.deepEqual([out.x, out.y], [-400, -200]);
  });
});

describe("scaleSvgPathData", () => {
  it("scales M/L/H/V/C coordinate pairs", () => {
    assert.equal(
      scaleSvgPathData("M 10 20 L 30 40 H 50 V 60 C 1 2 3 4 5 6 Z", 2, 3),
      "M 20 60 L 60 120 H 100 V 180 C 2 6 6 12 10 18 Z",
    );
  });

  it("treats moveto-repeats as implicit lineto (letter omitted, valid SVG) and scales arcs with flags intact", () => {
    assert.equal(
      scaleSvgPathData("M0 0 10 10 A 10 20 0 1 0 30 40", 2, 3),
      "M 0 0 20 30 A 20 60 0 1 0 60 120",
    );
  });

  it("returns malformed path data unchanged", () => {
    const weird = "M 10 20 L not-a-number";
    assert.equal(scaleSvgPathData(weird, 2, 2), weird);
    assert.equal(scaleSvgPathData("Q 1 2 3", 2, 2), "Q 1 2 3");
  });

  it("scales textPath elements through scaleElement", () => {
    const t: TextElement = { ...text("t", 10, 10, 20), textPath: "M 10 20 L 30 40" };
    const out = scaleElement(t, 2, 2) as TextElement;
    assert.equal(out.textPath, "M 20 40 L 60 80");
  });
});

describe("edge cases", () => {
  it("handles an empty page (dimensions still change)", () => {
    const out = scalePage(page([]), 1080, 1920);
    assert.equal(out.elements.length, 0);
    assert.equal(out.width, 1080);
    assert.equal(out.height, 1920);
  });

  it("is a no-op for invalid dimensions", () => {
    const p = page([rect("r", 10, 10, 20, 20)]);
    assert.equal(scalePage(p, 0, 1080), p);
    assert.equal(scalePage(p, -5, 1080), p);
    const zeroPage = page([rect("r", 10, 10, 20, 20)], 0, 1080);
    assert.equal(scalePage(zeroPage, 1080, 1080), zeroPage);
  });

  it("is idempotent: resize up then back down returns the original", () => {
    const els = [
      rect("r", 100, 50, 200, 100),
      text("t", 10, 20, 24, 300),
      { ...rect("l-off", -30, 40, 60, 60), rotation: 15, locked: true },
    ];
    const p = page(els);
    const back = scalePage(scalePage(p, 2160, 2160), 1080, 1080);
    assert.deepEqual(back, p);
  });

  it("does not mutate the input page or elements", () => {
    const r = rect("r", 100, 50, 200, 100);
    const p = page([r]);
    scalePage(p, 2160, 2160);
    assert.deepEqual([r.x, r.y, r.width, r.height], [100, 50, 200, 100]);
    assert.deepEqual([p.width, p.height], [1080, 1080]);
  });
});

// Marketr — Phase 11 "Canvas": FEATURE 4 — SVG serializer tests.
// Run: npx tsx --test lib/design/__tests__/export-svg.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  blankDocument,
  DESIGN_SCHEMA_VERSION,
  type ChartElement,
  type DesignDocument,
  type DesignElement,
  type EllipseElement,
  type ImageElement,
  type LineElement,
  type QrElement,
  type RectElement,
  type SvgElement,
  type TextElement,
} from "../types";
import {
  elementToSvg,
  escapeXml,
  exportPageToSvg,
  formatNumber,
  qrModules,
  qrToSvg,
  svgFilename,
} from "../export-svg";

const base = (overrides: Partial<DesignElement> = {}): DesignElement =>
  ({
    id: "el-1",
    type: "text",
    name: "El",
    x: 10,
    y: 20,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    ...overrides,
  }) as DesignElement;

const textEl = (overrides: Partial<TextElement> = {}): TextElement =>
  base({ type: "text", text: "Hello", fontFamily: "Inter", fontSize: 48, fontStyle: "normal", fill: "#111111", align: "left", lineHeight: 1.2, letterSpacing: 0, ...overrides }) as TextElement;

function docWith(...elements: DesignElement[]): DesignDocument {
  const doc = blankDocument(1080, 1080, "#fafafa");
  doc.pages[0]!.elements = elements;
  return doc;
}

describe("escapeXml", () => {
  it("escapes <, >, &, quotes", () => {
    assert.equal(escapeXml(`a < b & "c" > 'd'`), "a &lt; b &amp; &quot;c&quot; &gt; &#39;d&#39;");
  });
});

describe("formatNumber", () => {
  it("rounds float noise", () => {
    assert.equal(formatNumber(10.126), "10.13");
    assert.equal(formatNumber(-0.0001), "0");
    assert.equal(formatNumber(NaN), "0");
  });
});

describe("svgFilename", () => {
  it("combines design name + page name, sanitized", () => {
    assert.equal(svgFilename("Summer Sale!", "Page 1"), "Summer Sale-Page 1.svg");
    assert.equal(svgFilename("", ""), "design-design.svg");
  });
});

describe("exportPageToSvg", () => {
  it("serializes an empty document with background", () => {
    const doc = blankDocument(1080, 1080, "#fafafa");
    const res = exportPageToSvg(doc, doc.pages[0]!.id);
    assert.ok(res.ok);
    assert.ok(res.svg.startsWith("<?xml"));
    assert.ok(res.svg.includes("<svg"));
    assert.ok(res.svg.includes('viewBox="0 0 1080 1080"'));
    assert.ok(res.svg.includes('fill="#fafafa"'));
    assert.ok(!res.svg.includes("<text"));
  });

  it("rejects an invalid document", () => {
    const res = exportPageToSvg({ schemaVersion: 999, pages: [] }, "page-1");
    assert.ok(!res.ok);
    assert.ok(res.error.length > 0);
  });

  it("rejects an unknown page id", () => {
    const res = exportPageToSvg(blankDocument(100, 100), "nope");
    assert.ok(!res.ok);
    assert.match(res.error, /page not found/);
  });

  it("skips invisible elements", () => {
    const el = textEl({ visible: false });
    const doc = docWith(el);
    const res = exportPageToSvg(doc, doc.pages[0]!.id);
    assert.ok(res.ok);
    assert.ok(!res.svg.includes("<text"));
  });
});

describe("element coverage", () => {
  it("text -> <text>", () => {
    const out = elementToSvg(textEl(), {});
    assert.ok(out.includes("<text"));
    assert.ok(out.includes("Hello"));
    assert.ok(out.includes('font-family="Inter"'));
  });

  it("text fragments -> <tspan> runs", () => {
    const el = textEl({
      fragments: [
        { text: "Bold ", fontStyle: "bold", fill: "#ff0000" },
        { text: "plain" },
      ],
    });
    const out = elementToSvg(el, {});
    const tspans = out.match(/<tspan/g) ?? [];
    assert.equal(tspans.length, 2);
    assert.ok(out.includes('font-weight="bold"'));
    assert.ok(out.includes('fill="#ff0000"'));
  });

  it("textPath -> <textPath>", () => {
    const el = textEl({ textPath: "M 0 0 Q 50 50 100 0" });
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<textPath"));
    assert.ok(out.includes('d="M 0 0 Q 50 50 100 0"'));
  });

  it("escapes special chars in text", () => {
    const el = textEl({ text: "a < b & c" });
    const out = elementToSvg(el, {});
    assert.ok(out.includes("a &lt; b &amp; c"));
    assert.ok(!out.includes("a < b"));
  });

  it("rect -> <rect>, gradient -> linearGradient", () => {
    const el = base({
      type: "rect",
      width: 100,
      height: 50,
      fill: "#fff",
      gradient: ["#000000", "#ffffff"],
      cornerRadius: 8,
      stroke: "#333",
      strokeWidth: 2,
    }) as RectElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<rect"));
    assert.ok(out.includes("<linearGradient"));
    assert.ok(out.includes('fill="url(#grad-el-1)"'));
    assert.ok(out.includes('rx="8"'));
    assert.ok(out.includes('stroke="#333"'));
  });

  it("ellipse -> <ellipse> with center coords", () => {
    const el = base({ type: "ellipse", radiusX: 30, radiusY: 20, fill: "#abc" }) as EllipseElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<ellipse"));
    assert.ok(out.includes('cx="10" cy="20"'));
  });

  it("line -> <polyline> with dash", () => {
    const el = base({
      type: "line",
      points: [0, 0, 50, 50],
      stroke: "#000",
      strokeWidth: 3,
      dash: [6, 4],
    }) as LineElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<polyline"));
    assert.ok(out.includes('points="10,20 60,70"'));
    assert.ok(out.includes('stroke-dasharray="6 4"'));
  });

  it("svg icon -> scaled <path>", () => {
    const el = base({ type: "svg", path: "M0 0h24v24H0z", width: 48, height: 48, fill: "#000" }) as SvgElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<path"));
    assert.ok(out.includes("scale(2,2)"));
  });

  it("image embeds data URL src verbatim", () => {
    const el = base({
      type: "image",
      src: "data:image/png;base64,AAAA",
      width: 200,
      height: 100,
      cornerRadius: 0,
    }) as ImageElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<image"));
    assert.ok(out.includes('href="data:image/png;base64,AAAA"'));
  });

  it("image honors imageSources override and cornerRadius clip", () => {
    const el = base({
      type: "image",
      src: "https://example.com/a.png",
      width: 200,
      height: 100,
      cornerRadius: 12,
    }) as ImageElement;
    const out = elementToSvg(el, { imageSources: { "el-1": "data:image/png;base64,BBBB" } });
    assert.ok(out.includes('href="data:image/png;base64,BBBB"'));
    assert.ok(out.includes("<clipPath"));
  });

  it("remote image without override keeps external href with warning", () => {
    const el = base({
      type: "image",
      src: "https://example.com/a.png",
      width: 200,
      height: 100,
      cornerRadius: 0,
    }) as ImageElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes('href="https://example.com/a.png"'));
    assert.ok(out.includes("external href"));
  });

  it("chart bar -> bars with cycling colors + value labels", () => {
    const el = base({
      type: "chart",
      chartType: "bar",
      labels: ["A", "B", "C"],
      values: [10, 20, 30],
      colors: ["#111", "#222"],
      showValues: true,
    }) as ChartElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<rect"));
    assert.ok(out.includes('fill="#111"'));
    assert.ok(out.includes('fill="#222"')); // colors cycle
    assert.ok(out.includes(">30<"));
  });

  it("chart line -> <polyline> + markers", () => {
    const el = base({
      type: "chart",
      chartType: "line",
      labels: ["A", "B"],
      values: [5, 15],
      colors: ["#7c3aed"],
      showValues: false,
    }) as ChartElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("<polyline"));
    assert.ok(out.includes("<circle"));
  });

  it("chart pie -> slice <path>s", () => {
    const el = base({
      type: "chart",
      chartType: "pie",
      labels: ["A", "B"],
      values: [1, 3],
      colors: ["#111", "#222"],
      showValues: false,
    }) as ChartElement;
    const out = elementToSvg(el, {});
    assert.ok(out.match(/<path/g)!.length >= 2);
    assert.ok(out.includes(" A ")); // arc flags present
  });

  it("rotation + opacity applied", () => {
    const el = base({ type: "rect", width: 10, height: 10, fill: "#000", cornerRadius: 0, rotation: 45, opacity: 0.5 }) as RectElement;
    const out = elementToSvg(el, {});
    assert.ok(out.includes("rotate(45 10 20)"));
    assert.ok(out.includes('opacity="0.5"'));
  });

  it("unknown element type is skipped with a comment, never throws", () => {
    const weird = { ...base(), type: "hologram" } as unknown as DesignElement;
    const out = elementToSvg(weird, {});
    assert.ok(out.includes("unknown element type"));
    assert.ok(out.includes("hologram"));
  });
});

describe("qr", () => {
  it("qrModules computes a real grid", () => {
    const grid = qrModules("https://example.com");
    assert.ok(grid.size >= 21);
    // finder pattern corner is dark
    assert.ok(grid.dark(0, 0));
  });

  it("qr -> background rect + dark-module rects", () => {
    const el = base({
      type: "qr",
      payload: "https://example.com",
      size: 200,
      foreground: "#000000",
      background: "#ffffff",
    }) as QrElement;
    const out = qrToSvg(el);
    assert.ok(out.includes('fill="#ffffff"'));
    assert.ok(out.includes('fill="#000000"'));
    assert.ok((out.match(/<rect/g) ?? []).length > 10);
  });
});

describe("schema version constant", () => {
  it("document validates at the current schema version", () => {
    const doc = blankDocument(100, 100);
    assert.equal(doc.schemaVersion, DESIGN_SCHEMA_VERSION);
    const res = exportPageToSvg(doc, doc.pages[0]!.id);
    assert.ok(res.ok);
  });
});

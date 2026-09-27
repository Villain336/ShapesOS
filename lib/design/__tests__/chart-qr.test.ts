// Marketr — Phase 11 "Canvas": charts + QR tests.
// Run: npx tsx --test lib/design/__tests__/chart-qr.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  barModel,
  colorFor,
  DEFAULT_CHART_COLORS,
  formatChartValue,
  lineModel,
  niceCeil,
  pieLayout,
  pieSlices,
} from "../chart-math";
import { buildQrMatrix, QR_QUIET_ZONE } from "../qr";
import { validateDesignDocument } from "../validate";
import type { ChartElement, DesignDocument, QrElement } from "../types";

function chartEl(partial: Partial<ChartElement> = {}): ChartElement {
  return {
    id: "el-chart",
    name: "Chart",
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    type: "chart",
    chartType: "bar",
    labels: ["A", "B", "C"],
    values: [10, 20, 30],
    colors: ["#7c3aed"],
    showValues: true,
    ...partial,
  };
}

function qrEl(partial: Partial<QrElement> = {}): QrElement {
  return {
    id: "el-qr",
    name: "QR",
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    type: "qr",
    payload: "https://example.com",
    size: 160,
    foreground: "#1c1917",
    background: "#ffffff",
    ...partial,
  };
}

function docWith(elements: DesignDocument["pages"][0]["elements"]) {
  return {
    schemaVersion: 1,
    pages: [
      {
        id: "p1",
        name: "Page 1",
        width: 1080,
        height: 1080,
        background: "#ffffff",
        elements,
      },
    ],
  };
}

describe("chart-math helpers", () => {
  it("niceCeil rounds up to friendly axis ceilings", () => {
    assert.equal(niceCeil(42), 50);
    assert.equal(niceCeil(68), 100);
    assert.equal(niceCeil(0.3), 0.5);
    assert.equal(niceCeil(7), 10);
  });

  it("formatChartValue compacts thousands and keeps integers plain", () => {
    assert.equal(formatChartValue(1500), "1.5k");
    assert.equal(formatChartValue(2000), "2k");
    assert.equal(formatChartValue(42), "42");
    assert.equal(formatChartValue(3.14), "3.1");
  });

  it("colorFor cycles the palette and falls back to defaults", () => {
    assert.equal(colorFor(0, ["#111"]), "#111");
    assert.equal(colorFor(3, ["#111", "#222"]), "#222");
    assert.equal(colorFor(0, []), DEFAULT_CHART_COLORS[0]);
  });

  it("barModel yields one bar per value with sane geometry", () => {
    const m = barModel(["A", "B"], [10, 20], ["#7c3aed"], 480, 300);
    assert.equal(m.bars.length, 2);
    for (const b of m.bars) {
      assert.ok(b.w > 0 && b.h > 0);
      assert.ok(b.x >= 0 && b.cx > b.x);
    }
    assert.ok(m.ticks.length > 0);
  });

  it("lineModel builds polyline points and area closure", () => {
    const m = lineModel(["A", "B", "C"], [5, 15, 10], ["#7c3aed"], 480, 300);
    assert.equal(m.points.length, 6);
    assert.equal(m.dots.length, 3);
    assert.ok(m.areaPoints.length > m.points.length);
  });

  it("pieSlices fractions sum to 1 and start at 12 o'clock", () => {
    const s = pieSlices(["A", "B"], [1, 3], ["#7c3aed", "#0ea5e9"]);
    assert.equal(s.length, 2);
    const total = s.reduce((a, x) => a + x.fraction, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.equal(s[0]!.startDeg, -90);
    assert.ok(Math.abs(s[1]!.sweepDeg - 270) < 1e-9);
  });

  it("pieLayout keeps radius positive on small canvases", () => {
    const L = pieLayout(200, 150, 3);
    assert.ok(L.r > 0 && L.cx > 0);
  });
});

describe("QR matrix", () => {
  it("builds a square grid with quiet zone included", () => {
    const m = buildQrMatrix("https://example.com");
    assert.ok(m.size > 0);
    assert.equal(m.modules.length, m.size);
    assert.equal(m.modules[0]!.length, m.size);
    // Quiet zone corners are light.
    assert.equal(m.modules[0]![0], false);
    assert.equal(m.modules[QR_QUIET_ZONE]![QR_QUIET_ZONE], true); // finder top-left dark
    assert.ok(m.version >= 1);
  });

  it("never throws on empty or long payloads", () => {
    const empty = buildQrMatrix("");
    assert.equal(empty.size, 0);
    const long = buildQrMatrix("x".repeat(2048));
    assert.ok(long.size >= 0); // may succeed or fall back — never throws
  });
});

describe("validator: chart + qr elements", () => {
  it("accepts valid chart and qr elements", () => {
    const r = validateDesignDocument(docWith([chartEl(), qrEl()]));
    assert.equal(r.ok, true);
  });

  it("rejects an unknown chartType", () => {
    const r = validateDesignDocument(
      docWith([chartEl({ chartType: "radar" as unknown as "bar" })]),
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /chartType/);
  });

  it("rejects non-numeric chart values", () => {
    const r = validateDesignDocument(
      docWith([chartEl({ values: [1, "two" as unknown as number] })]),
    );
    assert.equal(r.ok, false);
  });

  it("rejects an empty QR payload", () => {
    const r = validateDesignDocument(docWith([qrEl({ payload: "" })]));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /payload/);
  });

  it("rejects a non-positive QR size", () => {
    const r = validateDesignDocument(docWith([qrEl({ size: 0 })]));
    assert.equal(r.ok, false);
  });
});

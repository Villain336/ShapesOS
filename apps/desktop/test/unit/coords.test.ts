import { describe, expect, it } from "vitest";
import {
  captureSize,
  displayForPoint,
  imageScale,
  imageToLocal,
  localToGlobal,
  numberDisplays,
  physicalToGlobal,
  placeCard,
  resolveElementPoint,
  resolveScreenPoint,
  uiMapForTurn,
  uiRectToGlobal,
  type DisplayLike,
} from "../../src/shared/coords";

// A realistic messy layout: a Retina laptop (primary, 2x), a 1080p monitor
// to its LEFT (negative origin, 1x) and a 4K monitor ABOVE-RIGHT at 1.5x
// (Windows-style fractional scaling, negative y).
const laptop: DisplayLike = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 };
const left: DisplayLike = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
const top: DisplayLike = { id: 3, bounds: { x: 1512, y: -1440, width: 2560, height: 1440 }, scaleFactor: 1.5 };
const all = [top, left, laptop];

describe("numberDisplays", () => {
  it("puts the primary first, then left to right", () => {
    const n = numberDisplays(all, 1);
    expect(n.map((d) => [d.id, d.screen, d.primary])).toEqual([
      [1, 0, true],
      [2, 1, false],
      [3, 2, false],
    ]);
  });
});

describe("DPI and screenshot scale", () => {
  it("image scale is image px per point (2 on Retina at full size, less when downscaled)", () => {
    expect(imageScale(laptop, 3024)).toBe(2);
    expect(imageScale(laptop, 1512)).toBe(1);
    expect(imageScale(top, 1568)).toBeCloseTo(0.6125, 4);
  });

  it("captureSize fits the biggest display's physical pixels into maxEdge without upscaling", () => {
    expect(captureSize([left], 1568)).toEqual({ width: 1568, height: 882 });
    expect(captureSize([{ ...left, bounds: { ...left.bounds, width: 800, height: 600 } }], 1568)).toEqual({ width: 800, height: 600 });
    const s = captureSize(all, 1568);
    expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(1568);
  });

  it("maps a model coordinate on a downscaled Retina screenshot back to points", () => {
    const scale = imageScale(laptop, 1568); // 1568 / 1512
    const local = imageToLocal({ x: 784, y: 400 }, scale);
    expect(local.x).toBeCloseTo(756, 6);
    expect(local.y).toBeCloseTo(385.71, 2);
  });
});

describe("multiple monitors and negative origins", () => {
  const n = numberDisplays(all, 1);

  it("resolves point { screen, x, y } to that display's local point", () => {
    const r = resolveScreenPoint(n, { screen: 1, x: 100, y: 50 });
    expect(r?.display.id).toBe(2);
    expect(r?.local).toEqual({ x: 100, y: 50 });
    expect(localToGlobal(r!.local, r!.display)).toEqual({ x: -1820, y: 50 });
  });

  it("clamps points just outside the display and ignores unknown screens", () => {
    expect(resolveScreenPoint(n, { screen: 0, x: 5000, y: -3 })?.local).toEqual({ x: 1511, y: 0 });
    expect(resolveScreenPoint(n, { screen: 7, x: 1, y: 1 })).toBeNull();
    expect(resolveScreenPoint(n, { screen: 0, x: Number.NaN, y: 1 })).toBeNull();
  });

  it("finds the display for a global point with negative coordinates", () => {
    expect(displayForPoint(all, { x: -5, y: 10 })?.id).toBe(2);
    expect(displayForPoint(all, { x: 2000, y: -10 })?.id).toBe(3);
    // In the gap below the top monitor and right of the laptop: nearest wins
    // (500 pt below the top monitor beats 1488 pt right of the laptop).
    expect(displayForPoint(all, { x: 3000, y: 500 })?.id).toBe(3);
  });
});

describe("uiMap → screen", () => {
  const uiMap = [
    { id: "nav:/dashboard/approvals", label: "Approvals", role: "link", rect: { x: 10, y: 200, w: 200, h: 40 } },
    { id: "hidden", label: "Hidden", role: "button", rect: { x: 0, y: 0, w: 0, h: 0 } },
  ];

  it("applies window content bounds and zoom", () => {
    expect(uiRectToGlobal(uiMap[0]!.rect, { x: -1800, y: 100, width: 1200, height: 800 }, 1.25)).toEqual({
      x: -1787.5,
      y: 350,
      width: 250,
      height: 50,
    });
  });

  it("resolves an elementId to the display holding it (window on a left monitor)", () => {
    const r = resolveElementPoint(uiMap, "nav:/dashboard/approvals", { x: -1800, y: 100, width: 1200, height: 800 }, 1, all);
    expect(r?.display.id).toBe(2);
    expect(r?.local).toEqual({ x: 230, y: 320 }); // centre: -1800 + 110 = -1690 global → 230 local
    expect(resolveElementPoint(uiMap, "missing", { x: 0, y: 0, width: 10, height: 10 }, 1, all)).toBeNull();
  });

  it("converts the uiMap to screen-local points for the turn and drops zero-size entries", () => {
    const n = numberDisplays(all, 1);
    const r = uiMapForTurn(uiMap, { x: -1800, y: 100, width: 1200, height: 800 }, 1, n);
    expect(r.screen).toBe(1);
    expect(r.entries).toEqual([
      { id: "nav:/dashboard/approvals", label: "Approvals", role: "link", rect: { x: 130, y: 300, w: 200, h: 40 } },
    ]);
  });
});

describe("physical pixels (Windows per-monitor DPI)", () => {
  it("converts relative to the display whose physical rect holds the point", () => {
    const d1 = { ...laptop, scaleFactor: 1.5, nativeOrigin: { x: 0, y: 0 } };
    const d2 = { ...left, nativeOrigin: { x: -1920, y: 0 } };
    expect(physicalToGlobal({ x: 300, y: 150 }, [d2, d1])).toEqual({ x: 200, y: 100 });
    expect(physicalToGlobal({ x: -1000, y: 10 }, [d2, d1])).toEqual({ x: -1000, y: 10 });
  });
});

describe("placeCard", () => {
  it("keeps a card on screen near the anchor", () => {
    expect(placeCard({ x: 100, y: 100 }, { width: 300, height: 120 }, laptop)).toEqual({ x: 116, y: 116 });
    const p = placeCard({ x: 1500, y: 970 }, { width: 300, height: 120 }, laptop);
    expect(p.x + 300).toBeLessThanOrEqual(1512);
    expect(p.y + 120).toBeLessThanOrEqual(982);
  });
});

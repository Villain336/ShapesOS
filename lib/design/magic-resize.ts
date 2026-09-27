// Marketr — Phase 11 "Canvas": Magic Resize scaling math.
// Pure functions (no store, no DOM) so they are unit-testable. The store
// action `magicResize` in store.ts wraps `scalePage` inside commit(), which
// makes the whole resize a single undoable history step.
//
// Scaling rules:
// - x/y scale by (newW/oldW, newH/oldH); elements partially off-page stay
//   proportionally placed (no clipping — negatives scale like everything else).
// - rotation, opacity, visibility, lock, name, and custom metadata are untouched.
// - fontSize (and per-fragment fontSize) scale by min(sx, sy) so text never
//   overflows its scaled wrap box on a non-uniform resize; rounded to 0.5pt.
// - Wrap width scales by sx. lineHeight (a multiplier) and letterSpacing are
//   left alone — the font-size change carries the visual proportion.
// - Corner radii and QR size scale by min(sx, sy) (isotropic quantities).
// - Ellipse radii scale independently (sx / sy); line points are in element-
//   local coords, so even indices scale by sx, odd by sy.
// - strokeWidth and dash patterns are cosmetic constants and are NOT scaled.
// - Chart elements carry no size fields in the schema (the renderer lays them
//   out from data), so only their position scales.
// - textPath (text-on-a-path): the path data IS rewritten by
//   scaleSvgPathData, a minimal SVG path parser. A CSS/DOM transform is not an
//   option — there is no transform field on elements (types.ts is frozen), so
//   rewriting the coordinates keeps layout correct without a schema change.
//   Malformed path data is returned untouched rather than corrupted.

import type { DesignElement, DesignPage, TextElement } from "./types";

/** Round to 2 decimals — keeps stored JSON clean (no float dust). */
const r2 = (n: number): number => Math.round(n * 100) / 100;
/** Font sizes round to the nearest 0.5pt — finer steps are invisible. */
const rHalf = (n: number): number => Math.round(n * 2) / 2;

/**
 * Scale an entire page to a new width/height. Returns a new page object;
 * the input is never mutated. Invalid dimensions (old or new ≤ 0) return the
 * page unchanged.
 */
export function scalePage(
  page: DesignPage,
  newWidth: number,
  newHeight: number,
): DesignPage {
  const { width: oldW, height: oldH } = page;
  if (
    !Number.isFinite(oldW) ||
    !Number.isFinite(oldH) ||
    oldW <= 0 ||
    oldH <= 0 ||
    !Number.isFinite(newWidth) ||
    !Number.isFinite(newHeight) ||
    newWidth <= 0 ||
    newHeight <= 0
  ) {
    return page;
  }
  const sx = newWidth / oldW;
  const sy = newHeight / oldH;
  return {
    ...page,
    width: newWidth,
    height: newHeight,
    elements: page.elements.map((el) => scaleElement(el, sx, sy)),
  };
}

export function scaleElement(
  el: DesignElement,
  sx: number,
  sy: number,
): DesignElement {
  // Isotropic (circular) quantities follow the smaller axis so they never
  // exceed the scaled box in either direction.
  const iso = Math.min(sx, sy);
  const x = r2(el.x * sx);
  const y = r2(el.y * sy);
  switch (el.type) {
    case "text": {
      const scaled: TextElement = {
        ...el,
        x,
        y,
        fontSize: rHalf(Math.max(1, el.fontSize * iso)),
        width: el.width === undefined ? undefined : r2(el.width * sx),
      };
      // Preserve the original shape: only touch optional fields when present.
      if (el.fragments !== undefined) {
        scaled.fragments = el.fragments.map((f) =>
          f.fontSize === undefined
            ? f
            : { ...f, fontSize: rHalf(Math.max(1, f.fontSize * iso)) },
        );
      }
      if (el.textPath) scaled.textPath = scaleSvgPathData(el.textPath, sx, sy);
      return scaled;
    }
    case "image":
      return {
        ...el,
        x,
        y,
        width: r2(el.width * sx),
        height: r2(el.height * sy),
        cornerRadius: r2(el.cornerRadius * iso),
      };
    case "rect":
      return {
        ...el,
        x,
        y,
        width: r2(el.width * sx),
        height: r2(el.height * sy),
        cornerRadius: r2(el.cornerRadius * iso),
      };
    case "ellipse":
      return { ...el, x, y, radiusX: r2(el.radiusX * sx), radiusY: r2(el.radiusY * sy) };
    case "line":
      return {
        ...el,
        x,
        y,
        points: el.points.map((p, i) => r2(p * (i % 2 === 0 ? sx : sy))),
      };
    case "svg":
      return { ...el, x, y, width: r2(el.width * sx), height: r2(el.height * sy) };
    case "chart":
      // No size fields in the schema — position only.
      return { ...el, x, y };
    case "qr":
      return { ...el, x, y, size: r2(el.size * iso) };
  }
}

// ── SVG path scaling (for textPath) ──────────────────────────────────────
// Minimal parser for the M/L/H/V/C/S/Q/T/A/Z command set (both cases).
// Coordinate pairs scale (x*sx, y*sy); arc rx/ry scale independently while
// the rotation and large-arc/sweep flags are passed through untouched.
// Anything unparseable is returned verbatim — never silently corrupted.

const PARAM_COUNTS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const fmtNum = (n: number): string => String(Math.round(n * 1000) / 1000);

function scaleParamGroup(cmd: string, nums: number[], sx: number, sy: number): string {
  if (cmd === "H") return fmtNum(nums[0]! * sx);
  if (cmd === "V") return fmtNum(nums[0]! * sy);
  if (cmd === "A") {
    // rx ry x-axis-rotation large-arc-flag sweep-flag x y
    const [rx, ry, rot, large, sweep, ax, ay] = nums;
    return [fmtNum(rx! * sx), fmtNum(ry! * sy), fmtNum(rot!), large, sweep, fmtNum(ax! * sx), fmtNum(ay! * sy)].join(" ");
  }
  // All other commands take (x,y) pairs.
  const out: string[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    out.push(fmtNum(nums[i]! * sx), fmtNum(nums[i + 1]! * sy));
  }
  return out.join(" ");
}

export function scaleSvgPathData(d: string, sx: number, sy: number): string {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g);
  if (!tokens) return d;
  const out: string[] = [];
  let i = 0;
  let cmd = "";
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/[A-Za-z]/.test(t)) {
      cmd = t.toUpperCase();
      if (!(cmd in PARAM_COUNTS)) return d; // unknown command — bail unchanged
      out.push(t); // preserve the original case of the command letter
      i += 1;
      if (cmd === "Z") continue;
    } else if (!cmd) {
      return d; // numbers before any command — bail unchanged
    }
    const count = PARAM_COUNTS[cmd]!;
    const group = tokens.slice(i, i + count);
    if (group.length < count || group.some((g) => /[A-Za-z]/.test(g))) return d;
    i += count;
    out.push(scaleParamGroup(cmd, group.map(Number), sx, sy));
    // In SVG, a moveto followed by extra coordinate pairs is an implicit lineto.
    if (cmd === "M") cmd = "L";
  }
  return out.join(" ");
}

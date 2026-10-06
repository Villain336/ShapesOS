// ShapesOS — Phase 18.1 (WS=find): design-token completeness and contrast (unit).
//
// docs/design/tokens.css is the source of truth. This suite parses it and
// checks that:
//   - every light colour token has a dark value (or is mode-invariant by
//     design: night surfaces, the *-on-night variants and the on-fill colours),
//   - the prefers-color-scheme block repeats the explicit dark block exactly,
//   - high contrast has a dark counterpart for each of its tokens,
//   - the four status colours keep their meaning on dark: marks >= 3:1 and
//     text >= 4.5:1 on dark paper and canvas; fills keep white/black text
//     legible; ink and muted text pass on every surface; focus reads,
//   - text sizes and control heights are rem (they scale with the text-size
//     preference), and the shell classes the layout emits all exist in CSS.
// Run: npx tsx --test lib/design/__tests__/tokens.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellClassNames } from "@/lib/preferences/shell";
import { CONTRASTS, DENSITIES, FONT_SCALES, MOTIONS, THEMES } from "@/lib/preferences/schema";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CSS = readFileSync(join(ROOT, "docs/design/tokens.css"), "utf8");
const GLOBALS = readFileSync(join(ROOT, "app/globals.css"), "utf8");
const TAILWIND = readFileSync(join(ROOT, "docs/design/tailwind.css"), "utf8");

/** Declarations of the first block whose selector text matches exactly. */
function block(selector: string, src = CSS): Map<string, string> {
  const at = src.indexOf(`${selector} {`);
  assert.ok(at >= 0, `block "${selector}" exists`);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  const body = src.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** The block inside `@media (prefers-color-scheme: dark)` for a selector. */
function mediaBlock(selector: string): Map<string, string> {
  const re = new RegExp(`@media \\(prefers-color-scheme: dark\\) \\{\\s*${selector.replace(/[.()]/g, (c) => `\\${c}`)} \\{`);
  const m = re.exec(CSS);
  assert.ok(m, `media block for "${selector}" exists`);
  return block(selector, CSS.slice(m!.index + m![0].indexOf(selector)));
}

const LIGHT = block(":root");
const DARK = block(":root.dark,\n:root.theme-dark");
const DARK_SYSTEM = mediaBlock(":root.theme-system");
const HC = block(":root.contrast-high");
const HC_DARK = block(":root.contrast-high:is(.dark, .theme-dark)");
const HC_DARK_SYSTEM = mediaBlock(":root.contrast-high.theme-system");

const isColor = (v: string) => /^#[0-9a-f]{6}$/i.test(v) || /^rgba?\(/i.test(v);
/** Same in both modes on purpose (night surfaces and on-fill colours). */
const MODE_INVARIANT = /^--aos-(night|on-|focus-on-night|running-on-night|done-on-night|failed-on-night)/;

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
const dark = (k: string) => DARK.get(k) ?? LIGHT.get(k)!;
const light = (k: string) => LIGHT.get(k)!;

describe("token completeness", () => {
  it("every light colour token has a dark value or is mode-invariant by design", () => {
    const colours = [...LIGHT].filter(([, v]) => isColor(v)).map(([k]) => k);
    assert.ok(colours.length > 30);
    const missing = colours.filter((k) => !DARK.has(k) && !MODE_INVARIANT.test(k));
    assert.deepEqual(missing, []);
    for (const k of DARK.keys()) assert.ok(LIGHT.has(k), `${k} exists in light`);
  });

  it("the system dark block repeats the explicit dark block exactly", () => {
    assert.deepEqual([...DARK_SYSTEM], [...DARK]);
    assert.deepEqual([...HC_DARK_SYSTEM], [...HC_DARK]);
  });

  it("high contrast has a dark counterpart for every token", () => {
    assert.deepEqual([...HC.keys()].sort(), [...HC_DARK.keys()].sort());
  });

  it("mode-invariant surfaces re-declare the light neutrals with the light values", () => {
    const surf = block(":root:is(.dark, .theme-dark) :is(.aos-night, .bg-night)");
    const fill = block(":root:is(.dark, .theme-dark) :is(.bg-running, .bg-done, .bg-failed, .bg-needs)");
    for (const [k, v] of surf) assert.equal(v, light(k), `night surface ${k}`);
    for (const [k, v] of fill) assert.equal(v, light(k), `status fill ${k}`);
    for (const k of ["--aos-ink", "--aos-paper", "--aos-text", "--aos-text-muted"]) assert.ok(surf.has(k) && fill.has(k), k);
    for (const k of ["--aos-running", "--aos-done", "--aos-failed", "--aos-needs"]) assert.ok(fill.has(k), k);
  });

  it("text sizes and control heights are rem (they follow the text-size preference)", () => {
    for (const [k, v] of LIGHT) if (/^--aos-(text-(2xs|xs|sm|md|base|lg|xl|2xl|3xl)|h-)/.test(k)) assert.match(v, /rem$/, k);
  });

  it("every class the shell can put on <html> is styled", () => {
    const all = new Set<string>();
    for (const theme of THEMES) for (const contrastPref of CONTRASTS) for (const density of DENSITIES) for (const motion of MOTIONS) for (const fontScale of FONT_SCALES) {
      for (const c of shellClassNames({ theme, contrast: contrastPref, density, motion, fontScale, language: null })) all.add(c);
    }
    for (const c of all) assert.ok(CSS.includes(`.${c}`) || GLOBALS.includes(`.${c}`), `.${c} has CSS`);
    assert.match(GLOBALS, /@custom-variant dark/);
    assert.match(TAILWIND, /--color-ink-hover: var\(--aos-ink-hover\)/);
  });
});

describe("contrast on dark (status colours keep their meaning)", () => {
  const surfaces = { paper: dark("--aos-paper"), canvas: dark("--aos-canvas") };
  it("status marks and status text read on dark paper and canvas", () => {
    for (const s of ["--aos-running", "--aos-done", "--aos-failed", "--aos-needs"]) {
      for (const [name, bg] of Object.entries(surfaces)) {
        assert.ok(contrast(dark(s), bg) >= 4.5, `${s} on dark ${name}: ${contrast(dark(s), bg).toFixed(2)}`);
      }
    }
    assert.ok(contrast(dark("--aos-failed-text"), surfaces.paper) >= 4.5);
    assert.ok(contrast(dark("--aos-failed-text"), dark("--aos-failed-tint")) >= 4.5);
    assert.ok(contrast(dark("--aos-running"), dark("--aos-running-tint")) >= 4.5);
  });

  it("filled badges keep their light fills and text (mode-invariant)", () => {
    assert.ok(contrast("#FFFFFF", light("--aos-running")) >= 4.5);
    assert.ok(contrast("#FFFFFF", light("--aos-done")) >= 4.5);
    assert.ok(contrast("#FFFFFF", light("--aos-failed")) >= 4.5);
    assert.ok(contrast("#000000", light("--aos-needs")) >= 4.5);
    assert.equal(light("--aos-on-needs"), "#000000", "black on yellow, always");
  });

  it("text, primary buttons and focus pass on dark", () => {
    for (const [name, bg] of Object.entries(surfaces)) {
      assert.ok(contrast(dark("--aos-text"), bg) >= 7, `text on ${name}`);
      assert.ok(contrast(dark("--aos-text-muted"), bg) >= 4.5, `muted on ${name}`);
      assert.ok(contrast(dark("--aos-text-subtle"), bg) >= 4.5, `subtle on ${name}`);
      assert.ok(contrast(dark("--aos-focus"), bg) >= 3, `focus on ${name}`);
    }
    // Primary button: ink fill with paper text, and its hover.
    assert.ok(contrast(dark("--aos-paper"), dark("--aos-ink")) >= 7);
    assert.ok(contrast(dark("--aos-paper"), dark("--aos-ink-hover")) >= 7);
    assert.ok(contrast(light("--aos-paper"), light("--aos-ink-hover")) >= 7);
  });

  it("high contrast strengthens secondary text and lines in both modes", () => {
    assert.ok(contrast(HC.get("--aos-text-muted")!, light("--aos-paper")) >= 7);
    assert.ok(contrast(HC_DARK.get("--aos-text-muted")!, dark("--aos-paper")) >= 7);
    assert.ok(contrast(HC.get("--aos-line")!, light("--aos-paper")) >= 3, "lines are UI boundaries (1.4.11)");
    assert.ok(contrast(HC_DARK.get("--aos-line")!, dark("--aos-paper")) >= 3);
    assert.equal(HC.get("--aos-focus-width"), "3px");
  });
});

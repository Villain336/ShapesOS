// Marketr — Phase 11 "Canvas" FEATURE 1: richer text (fragments + text-on-a-path).
//
// Pure helpers for the fragment model (per-range styling) and text-on-a-path
// presets. No DOM, no Konva, no React — safe to import in node:test suites.
//
// RENDER APPROACH (decision, evaluated 2026-09-27):
// Chose (b) grouped Konva Text nodes per run with manual word-wrap layout
// over (a) polotno-project/render-tag (HTML+CSS -> canvas bitmap):
//   - render-tag needs a new npm dependency and renders text to a RASTER
//     bitmap: text would blur under zoom, per-range editing would be lost
//     (the node becomes an image), and its CSS layout would not match
//     Konva's word-wrap, breaking WYSIWYG.
//   - (b) keeps everything vector: drag, transformer, snapping, and export
//     (stage.toDataURL for PNG/JPG/PDF) work unchanged, and export-svg.ts
//     already serializes fragments as <tspan> runs and textPath as
//     <textPath> — so every export path stays honest.
// Konva has no native rich-text node, so layoutRichText() below reimplements
// Konva's wrap="word" line breaking (break at whitespace; overlong words
// overflow their line) with an injectable measure() so tests can stub fonts.
//
// The fragment model: TextElement.fragments is a list of styled runs whose
// concatenation ALWAYS equals element.text. The rewrite helpers split runs
// at character offsets and re-merge adjacent runs with identical resolved
// style; the store keeps `text` in sync on every mutation.

import type { TextElement, TextFragment } from "./types";

export type FragmentStyleName = "normal" | "bold" | "italic" | "bold-italic";

/** Partial style applied to a character range. Omitted fields are untouched. */
export interface FragmentStyleInput {
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: FragmentStyleName;
  fill?: string;
}

/** A fragment with every style field resolved against the element base. */
export interface ResolvedFragment {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontStyle: FragmentStyleName;
  fill: string;
}

export interface FragmentBaseStyle {
  fontFamily: string;
  fontSize: number;
  fontStyle: FragmentStyleName;
  fill: string;
}

export function baseStyleOf(el: TextElement): FragmentBaseStyle {
  return {
    fontFamily: el.fontFamily,
    fontSize: el.fontSize,
    fontStyle: el.fontStyle,
    fill: el.fill,
  };
}

export function resolveFragment(
  base: FragmentBaseStyle,
  f: TextFragment,
): ResolvedFragment {
  return {
    text: f.text,
    fontFamily: f.fontFamily ?? base.fontFamily,
    fontSize: f.fontSize ?? base.fontSize,
    fontStyle: f.fontStyle ?? base.fontStyle,
    fill: f.fill ?? base.fill,
  };
}

export function concatFragments(fragments: TextFragment[]): string {
  return fragments.map((f) => f.text).join("");
}

/** True when the element carries per-fragment styling the renderer must honor. */
export function hasRichFragments(el: TextElement): boolean {
  return !!el.fragments && el.fragments.some((f) => f.text.length > 0);
}

function styleKey(r: ResolvedFragment): string {
  return `${r.fontFamily}\n${r.fontSize}\n${r.fontStyle}\n${r.fill}`;
}

/** Drop zero-length runs; merge adjacent runs with identical resolved style. */
function normalizeResolved(frags: ResolvedFragment[]): ResolvedFragment[] {
  const out: ResolvedFragment[] = [];
  for (const f of frags) {
    if (f.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && styleKey(prev) === styleKey(f)) prev.text += f.text;
    else out.push({ ...f });
  }
  return out;
}

/** Back to sparse TextFragments: omit fields identical to the element base. */
function sparsen(
  frags: ResolvedFragment[],
  base: FragmentBaseStyle,
): TextFragment[] {
  return frags.map((r) => {
    const f: TextFragment = { text: r.text };
    if (r.fontFamily !== base.fontFamily) f.fontFamily = r.fontFamily;
    if (r.fontSize !== base.fontSize) f.fontSize = r.fontSize;
    if (r.fontStyle !== base.fontStyle) f.fontStyle = r.fontStyle;
    if (r.fill !== base.fill) f.fill = r.fill;
    return f;
  });
}

function definedOnly(style: FragmentStyleInput): Partial<ResolvedFragment> {
  const out: Partial<ResolvedFragment> = {};
  if (style.fontFamily !== undefined) out.fontFamily = style.fontFamily;
  if (style.fontSize !== undefined) out.fontSize = style.fontSize;
  if (style.fontStyle !== undefined) out.fontStyle = style.fontStyle;
  if (style.fill !== undefined) out.fill = style.fill;
  return out;
}

function clampRange(
  text: string,
  start: number,
  end: number,
): { s: number; e: number } {
  const len = text.length;
  return {
    s: Math.max(0, Math.min(len, Math.floor(start))),
    e: Math.max(0, Math.min(len, Math.floor(end))),
  };
}

export interface ApplyFragmentResult {
  fragments: TextFragment[];
  text: string;
}

/**
 * Rewrite the character range [start, end) of a fragment list: split runs at
 * the range boundaries, apply `map` to the inside pieces, re-merge.
 * Returns null when the range is empty or the rewrite changes nothing (the
 * store skips the history commit in that case).
 */
function rewriteRange(
  fragments: TextFragment[],
  text: string,
  start: number,
  end: number,
  base: FragmentBaseStyle,
  map: (r: ResolvedFragment) => ResolvedFragment,
): ApplyFragmentResult | null {
  const { s, e } = clampRange(text, start, end);
  if (text.length === 0 || s >= e) return null;
  // Self-heal: if the stored runs don't concatenate to `text`, rebuild from
  // the plain text rather than corrupting offsets.
  const src =
    fragments.length > 0 && concatFragments(fragments) === text
      ? fragments
      : [{ text }];
  const resolved = src.map((f) => resolveFragment(base, f));
  const before = JSON.stringify(sparsen(normalizeResolved(resolved), base));

  const split: ResolvedFragment[] = [];
  let cursor = 0;
  for (const r of resolved) {
    const fStart = cursor;
    const fEnd = cursor + r.text.length;
    cursor = fEnd;
    const oStart = Math.max(s, fStart);
    const oEnd = Math.min(e, fEnd);
    if (oStart >= oEnd) {
      split.push(r);
      continue;
    }
    const rel = (x: number) => x - fStart;
    if (oStart > fStart) split.push({ ...r, text: r.text.slice(0, rel(oStart)) });
    split.push(map({ ...r, text: r.text.slice(rel(oStart), rel(oEnd)) }));
    if (oEnd < fEnd) split.push({ ...r, text: r.text.slice(rel(oEnd)) });
  }
  const after = sparsen(normalizeResolved(split), base);
  if (JSON.stringify(after) === before) return null;
  return { fragments: after, text: concatFragments(after) };
}

/**
 * Apply a partial style to the character range [start, end), building the
 * fragment model (creates it from plain text when absent). Returns null when
 * nothing changes.
 */
export function applyFragmentStyle(
  fragments: TextFragment[],
  text: string,
  start: number,
  end: number,
  style: FragmentStyleInput,
  base: FragmentBaseStyle,
): ApplyFragmentResult | null {
  if (Object.values(style).every((v) => v === undefined)) return null;
  const patch = definedOnly(style);
  return rewriteRange(fragments, text, start, end, base, (r) => ({
    ...r,
    ...patch,
  }));
}

function withFlag(
  fs: FragmentStyleName,
  flag: "bold" | "italic",
  on: boolean,
): FragmentStyleName {
  const hasBold = fs === "bold" || fs === "bold-italic";
  const hasItalic = fs === "italic" || fs === "bold-italic";
  const b = flag === "bold" ? on : hasBold;
  const i = flag === "italic" ? on : hasItalic;
  return b ? (i ? "bold-italic" : "bold") : i ? "italic" : "normal";
}

/** True when every fragment intersecting [start, end) carries the flag. */
export function rangeHasFlag(
  fragments: TextFragment[],
  text: string,
  start: number,
  end: number,
  flag: "bold" | "italic",
  base: FragmentBaseStyle,
): boolean {
  const { s, e } = clampRange(text, start, end);
  if (s >= e) return false;
  const src =
    fragments.length > 0 && concatFragments(fragments) === text
      ? fragments
      : [{ text }];
  let cursor = 0;
  for (const f of src) {
    const fStart = cursor;
    const fEnd = cursor + f.text.length;
    cursor = fEnd;
    if (Math.max(s, fStart) < Math.min(e, fEnd)) {
      const fs = f.fontStyle ?? base.fontStyle;
      if (!fs.includes(flag)) return false;
    }
  }
  return true;
}

/**
 * Toggle bold/italic on a range (per-fragment aware: preserves the other
 * flag). Returns null when nothing changes. The TextPanel commits the result
 * through the store's updateElement (undoable, fragment↔text sync-safe).
 */
export function toggleFragmentFlag(
  fragments: TextFragment[],
  text: string,
  start: number,
  end: number,
  flag: "bold" | "italic",
  base: FragmentBaseStyle,
): ApplyFragmentResult | null {
  const on = !rangeHasFlag(fragments, text, start, end, flag, base);
  return rewriteRange(fragments, text, start, end, base, (r) => ({
    ...r,
    fontStyle: withFlag(r.fontStyle, flag, on),
  }));
}

/**
 * The style fields that are uniform across every fragment intersecting
 * [start, end) (resolved against the base). Used to initialize the panel's
 * staged controls; non-uniform fields are omitted.
 */
export function rangeUniformStyle(
  fragments: TextFragment[],
  text: string,
  start: number,
  end: number,
  base: FragmentBaseStyle,
): FragmentStyleInput {
  const { s, e } = clampRange(text, start, end);
  const out: FragmentStyleInput = {};
  if (s >= e) return out;
  const src =
    fragments.length > 0 && concatFragments(fragments) === text
      ? fragments
      : [{ text }];
  const seen: ResolvedFragment[] = [];
  let cursor = 0;
  for (const f of src) {
    const fStart = cursor;
    const fEnd = cursor + f.text.length;
    cursor = fEnd;
    if (Math.max(s, fStart) < Math.min(e, fEnd)) seen.push(resolveFragment(base, f));
  }
  if (seen.length === 0) return out;
  const first = seen[0]!;
  if (seen.every((r) => r.fontFamily === first.fontFamily)) out.fontFamily = first.fontFamily;
  if (seen.every((r) => r.fontSize === first.fontSize)) out.fontSize = first.fontSize;
  if (seen.every((r) => r.fontStyle === first.fontStyle)) out.fontStyle = first.fontStyle;
  if (seen.every((r) => r.fill === first.fill)) out.fill = first.fill;
  return out;
}

// ── Manual rich-text layout ──────────────────────────────────────────────

export interface LayoutBase extends FragmentBaseStyle {
  lineHeight: number;
  letterSpacing: number;
  width?: number;
  align: "left" | "center" | "right";
}

export interface RichRun {
  text: string;
  x: number;
  y: number;
  fontFamily: string;
  fontSize: number;
  /** Konva fontStyle string ("bold italic" for bold-italic). */
  fontStyle: string;
  fill: string;
}

export interface MeasureStyle {
  fontFamily: string;
  fontSize: number;
  fontStyle: string;
  letterSpacing: number;
}

export type MeasureFn = (text: string, style: MeasureStyle) => number;

export function konvaFontStyleOf(s: FragmentStyleName): string {
  return s === "bold-italic" ? "bold italic" : s;
}

interface Tok {
  text: string;
  w: number;
  frag: number;
  space: boolean;
}
const PARA_BREAK: unique symbol = Symbol("para");

/**
 * Lay out fragment runs for Konva: one RichRun per same-fragment token run,
 * with x/y in element-local coords. Mirrors Konva's wrap="word" semantics:
 * lines break at whitespace; a word longer than the wrap width overflows its
 * line. Line advance is base.fontSize * lineHeight (uniform, like Konva).
 * `width` undefined = no wrapping. Alignment shifts whole lines.
 */
export function layoutRichText(opts: {
  fragments: TextFragment[];
  base: LayoutBase;
  measure: MeasureFn;
}): RichRun[] {
  const { base, measure } = opts;
  const resolved = opts.fragments
    .filter((f) => f.text.length > 0)
    .map((f) => resolveFragment(base, f));
  if (resolved.length === 0) return [];

  const maxWidth = base.width === undefined ? Infinity : base.width;
  const lineH = base.fontSize * base.lineHeight;

  // Tokenize: words and whitespace runs, with paragraph breaks.
  const toks: (Tok | typeof PARA_BREAK)[] = [];
  resolved.forEach((r, fi) => {
    const style: MeasureStyle = {
      fontFamily: r.fontFamily,
      fontSize: r.fontSize,
      fontStyle: konvaFontStyleOf(r.fontStyle),
      letterSpacing: base.letterSpacing,
    };
    r.text.split("\n").forEach((para, pi) => {
      if (pi > 0) toks.push(PARA_BREAK);
      for (const part of para.match(/\S+|\s+/g) ?? []) {
        toks.push({
          text: part,
          w: measure(part, style),
          frag: fi,
          space: /^\s+$/.test(part),
        });
      }
    });
  });

  // Greedy line breaking.
  const lines: Tok[][] = [];
  let cur: Tok[] = [];
  let x = 0;
  const newLine = () => {
    lines.push(cur);
    cur = [];
    x = 0;
  };
  for (const t of toks) {
    if (t === PARA_BREAK) {
      newLine();
      continue;
    }
    if (t.space) {
      if (x === 0) continue; // never start a line with a space
      if (x + t.w > maxWidth) {
        newLine();
        continue;
      }
      cur.push(t);
      x += t.w;
      continue;
    }
    if (x > 0 && x + t.w > maxWidth) newLine();
    cur.push(t);
    x += t.w;
  }
  lines.push(cur);

  // Emit runs: merge consecutive tokens from the same fragment.
  const runs: RichRun[] = [];
  lines.forEach((line, li) => {
    const lineW = line.reduce((a, t) => a + t.w, 0);
    const shift = !isFinite(maxWidth)
      ? 0
      : base.align === "center"
        ? (maxWidth - lineW) / 2
        : base.align === "right"
          ? maxWidth - lineW
          : 0;
    let cx = shift;
    let run: RichRun | null = null;
    let runFrag = -1;
    const flush = () => {
      if (run) {
        runs.push(run);
        run = null;
      }
    };
    for (const t of line) {
      const r = resolved[t.frag]!;
      if (run && runFrag === t.frag) {
        run.text += t.text;
      } else {
        flush();
        run = {
          text: t.text,
          x: cx,
          y: li * lineH,
          fontFamily: r.fontFamily,
          fontSize: r.fontSize,
          fontStyle: konvaFontStyleOf(r.fontStyle),
          fill: r.fill,
        };
        runFrag = t.frag;
      }
      cx += t.w;
    }
    flush();
  });
  return runs;
}

// ── Text-on-a-path presets ───────────────────────────────────────────────
// Path data is node-local (the element's x/y positions the path origin).

export interface TextPathPreset {
  key: "arc" | "wave" | "circle";
  label: string;
  data: string;
}

export const TEXT_PATH_PRESETS: TextPathPreset[] = [
  { key: "arc", label: "Arc", data: "M 0 70 Q 160 0 320 70" },
  { key: "wave", label: "Wave", data: "M 0 45 Q 80 5 160 45 T 320 45" },
  {
    key: "circle",
    label: "Circle",
    data: "M 60 160 a 100 100 0 1 1 200 0 a 100 100 0 1 1 -200 0",
  },
];

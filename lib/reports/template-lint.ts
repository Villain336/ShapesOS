// Marketr — Phase 16 slice 9: branded report engine — template lint.
//
// Gotcha found in the report-engine proof (~/workspace/biz-os/report-engine-proof):
// WeasyPrint SILENTLY DROPS the entire `background` shorthand when any layer
// uses CSS Images Level 4 double-position color stops (e.g. `transparent 0 22px`)
// — the first proof render came out with an invisible hero (white text on a
// transparent background). Template authors must know this; the engine lints
// every template's CSS and FAILS the template when the trap is present.
//
// Scope is deliberately narrow: this lints for the known WeasyPrint
// silent-drop traps, not general CSS validity.

export interface TemplateLintError {
  /** Short machine key: "double-position-color-stop" | "unbalanced-braces". */
  code: string;
  /** Human explanation with the offending line number. */
  message: string;
  /** 1-based line number in the CSS source. */
  line: number;
}

/**
 * Regex for CSS Images L4 double-position color stops: a color followed by
 * TWO positions, e.g. `red 0 22px`, `transparent 0%, rgba(0,0,0,.1) 50% 60%`.
 * Matches inside gradient functions only (linear-gradient, radial-gradient,
 * repeating-*, conic-gradient) — elsewhere a double length is legal CSS.
 */
const GRADIENT_FN = /(repeating-)?(linear|radial|conic)-gradient\(/gi;
const UNITS = "%|px|em|rem|pt|mm|cm|in|pc|ex|ch|vw|vh|vmin|vmax";
// Color token then two positions: `#fff 0 22px`, `red 0 50%`, `rgba(0,0,0,.5) 10% 20%`.
// Positions may be unitless 0 (legal CSS length).
const DOUBLE_POSITION_STOP = new RegExp(
  `(#[0-9a-f]{3,8}|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|[a-z]+(?:-[a-z]+)?)` +
    `\\s+(-?[\\d.]+(?:${UNITS})?)\\s+(-?[\\d.]+(?:${UNITS})?)`,
  "i",
);

function findGradientSpans(css: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  GRADIENT_FN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GRADIENT_FN.exec(css)) !== null) {
    let depth = 1;
    let i = GRADIENT_FN.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")") depth--;
    }
    spans.push({ start: match.index, end: i });
    GRADIENT_FN.lastIndex = i;
  }
  return spans;
}

function lineOf(css: string, index: number): number {
  return css.slice(0, index).split("\n").length;
}

/** Lint template CSS. Returns the list of errors (empty = clean). */
export function lintTemplateCss(css: string): TemplateLintError[] {
  const errors: TemplateLintError[] = [];

  for (const span of findGradientSpans(css)) {
    const body = css.slice(span.start, span.end);
    const hit = DOUBLE_POSITION_STOP.exec(body);
    if (hit) {
      errors.push({
        code: "double-position-color-stop",
        message:
          `CSS Images Level 4 double-position color stop ("${hit[0].trim()}") — ` +
          `WeasyPrint silently drops the whole background when this is present. ` +
          `Use single-position stops (e.g. "transparent 0, rgba(255,255,255,0.035) 22px").`,
        line: lineOf(css, span.start + hit.index),
      });
    }
  }

  // Cheap sanity: unbalanced braces usually mean a truncated/corrupt file.
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  if (open !== close) {
    errors.push({
      code: "unbalanced-braces",
      message: `Unbalanced braces: ${open} "{" vs ${close} "}" — template CSS may be truncated.`,
      line: css.split("\n").length,
    });
  }

  return errors;
}

/**
 * Hard gate used by template registration and the render service: throws
 * when the CSS fails lint. A failing template never reaches WeasyPrint.
 */
export function assertTemplateCssValid(css: string, templateName: string): void {
  const errors = lintTemplateCss(css);
  if (errors.length > 0) {
    const detail = errors.map((e) => `line ${e.line}: ${e.message}`).join("\n");
    throw new Error(`Report template "${templateName}" failed CSS lint:\n${detail}`);
  }
}

// ShapesOS — Phase 19A (WS=server): the cursor's tag parser (PURE).
//
// The cursor's brain answers in plain spoken text with inline tags
// (lib/cursor/prompt.ts teaches them):
//
//   [POINT:x,y:label:screenN]        point at a pixel of screenshot N
//   [POINT:x,y:label]                … on the primary screen
//   [POINT:#elementId:label]         point at a ShapesOS element (uiMap id)
//   [POINT:none]                     nothing to point at (no event)
//   [DRAW:circle:x,y:label:screenN]  circle around a point
//   [DRAW:arrow:x1,y1;x2,y2:label:screenN]   arrow from → to
//   [DRAW:step:N:x,y:label:screenN]  step number N at a point
//   [DICTATE:text]                   text to type into the focused field
//
// The server turns them into SSE events (point / draw / dictation) so the
// desktop never parses model text. Rules (strict):
//   - Coordinates are pixels on that screenshot; they are converted to screen
//     points (÷ the screenshot's pixels-per-point) and CLAMPED to that screen.
//   - A screen that was not sent, an element id not in the uiMap, a malformed
//     tag, and any unknown [WORD:…] tag are DROPPED (never spoken, no event).
//   - Spoken / displayed text never contains a tag; whitespace left behind is
//     tidied.
//   - Streaming-safe: tags split across deltas are buffered until complete.

export interface CursorScreen {
  /** Index the desktop gave the screenshot (the model sees "screen N"). */
  screen: number;
  /** Screenshot size in image pixels. */
  width: number;
  height: number;
  /** Image pixels per screen point (Electron's display scale factor for a native capture). */
  scaleFactor: number;
  primary: boolean;
}

export interface UiMapEntry {
  id: string;
  label: string;
  role: string;
  rect: { x: number; y: number; w: number; h: number };
}

export type CursorTagEvent =
  | { type: "point"; screen: number; x: number; y: number; label: string }
  | { type: "point"; elementId: string; label: string }
  | { type: "draw"; kind: "circle" | "arrow" | "step"; screen: number; points: Array<{ x: number; y: number }>; step?: number; label?: string }
  | { type: "dictation"; text: string };

export interface TagContext {
  screens: readonly CursorScreen[];
  /** Element ids the page published (only these may be pointed at by id). */
  elementIds?: ReadonlySet<string> | readonly string[];
}

/** Longest tag the parser buffers; longer brackets are not tags. */
export const MAX_TAG_CHARS = 2_000;
const MAX_LABEL = 120;
const MAX_DICTATION = 1_500;

const KNOWN = new Set(["POINT", "DRAW", "DICTATE"]);

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function cleanLabel(s: string | undefined): string {
  return (s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

function screenFor(ctx: TagContext, n: number | null): CursorScreen | null {
  if (n === null) return ctx.screens.find((s) => s.primary) ?? (ctx.screens.length === 1 ? ctx.screens[0]! : null);
  return ctx.screens.find((s) => s.screen === n) ?? null;
}

/** Screenshot pixels → screen points on that screen, clamped inside it. */
export function toScreenPoint(s: CursorScreen, px: number, py: number): { x: number; y: number } {
  const k = Number.isFinite(s.scaleFactor) && s.scaleFactor > 0 ? s.scaleFactor : 1;
  const wPts = Math.max(1, Math.round(s.width / k));
  const hPts = Math.max(1, Math.round(s.height / k));
  return { x: clampInt(px / k, 0, wPts - 1), y: clampInt(py / k, 0, hPts - 1) };
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const XY_RE = new RegExp(`^\\s*(${NUM})\\s*,\\s*(${NUM})\\s*$`);

function parseXY(s: string): { x: number; y: number } | null {
  const m = XY_RE.exec(s);
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Split off a trailing ":screenN" segment. */
function splitScreen(parts: string[]): { rest: string[]; screen: number | null } {
  const last = parts[parts.length - 1];
  const m = last !== undefined ? /^\s*screen\s*(\d{1,2})\s*$/i.exec(last) : null;
  if (!m) return { rest: parts, screen: null };
  return { rest: parts.slice(0, -1), screen: Number(m[1]) };
}

function hasElement(ctx: TagContext, id: string): boolean {
  const ids = ctx.elementIds;
  if (!ids) return false;
  return ids instanceof Set ? ids.has(id) : (ids as readonly string[]).includes(id);
}

/**
 * Parse ONE complete tag body (between "[" and "]"). Returns the event, or
 * null when the tag is dropped (malformed, unknown, out of context, none).
 */
export function parseTag(body: string, ctx: TagContext): CursorTagEvent | null {
  const colon = body.indexOf(":");
  if (colon < 1) return null;
  const name = body.slice(0, colon).trim().toUpperCase();
  const rest = body.slice(colon + 1);
  if (!KNOWN.has(name)) return null;

  if (name === "DICTATE") {
    const text = rest.replace(/\r\n?/g, "\n").trim().slice(0, MAX_DICTATION);
    return text ? { type: "dictation", text } : null;
  }

  const parts = rest.split(":");
  if (name === "POINT") {
    const first = (parts[0] ?? "").trim();
    if (/^none$/i.test(first)) return null;
    if (first.startsWith("#")) {
      // An element id may itself contain ":" (nav:/dashboard/x): the longest
      // prefix the uiMap knows is the id, the rest is the label.
      const all = rest.trim().slice(1).split(":");
      for (let cut = all.length; cut >= 1; cut--) {
        const candidate = all.slice(0, cut).join(":").trim();
        if (candidate && hasElement(ctx, candidate)) {
          return { type: "point", elementId: candidate, label: cleanLabel(all.slice(cut).join(":")) };
        }
      }
      return null;
    }
    const xy = parseXY(first);
    if (!xy) return null;
    const { rest: labelParts, screen: n } = splitScreen(parts.slice(1));
    const s = screenFor(ctx, n);
    if (!s) return null;
    const p = toScreenPoint(s, xy.x, xy.y);
    return { type: "point", screen: s.screen, x: p.x, y: p.y, label: cleanLabel(labelParts.join(":")) };
  }

  // DRAW
  const kind = (parts[0] ?? "").trim().toLowerCase();
  if (kind !== "circle" && kind !== "arrow" && kind !== "step") return null;
  let i = 1;
  let step: number | undefined;
  if (kind === "step") {
    const n = Number((parts[1] ?? "").trim());
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    step = n;
    i = 2;
  }
  const raw = (parts[i] ?? "").split(";").map((x) => x.trim()).filter(Boolean);
  const pts = raw.map(parseXY);
  if (pts.some((p) => p === null)) return null;
  const want = kind === "arrow" ? [2, 2] : kind === "circle" ? [1, 2] : [1, 1];
  if (pts.length < want[0]! || pts.length > want[1]!) return null;
  const { rest: labelParts, screen: n } = splitScreen(parts.slice(i + 1));
  const s = screenFor(ctx, n);
  if (!s) return null;
  const label = cleanLabel(labelParts.join(":"));
  return {
    type: "draw",
    kind,
    screen: s.screen,
    points: (pts as Array<{ x: number; y: number }>).map((p) => toScreenPoint(s, p.x, p.y)),
    ...(step !== undefined ? { step } : {}),
    ...(label ? { label } : {}),
  };
}

/** Could `buf` (starting with "[") still become a tag? */
function couldBeTag(buf: string): boolean {
  // "[" then an upper-case word, then ":" — anything else is ordinary text.
  return /^\[[A-Z_]{0,12}$/.test(buf) || /^\[[A-Z_]{2,12}:/.test(buf);
}

export interface TagParseResult {
  /** Spoken / displayed text (no tags). */
  text: string;
  events: CursorTagEvent[];
}

/**
 * Streaming parser: push() model text deltas, get back the text that is
 * safe to show/speak now plus any complete tags' events; end() flushes.
 */
export class CursorTagStream {
  private buf = "";
  private lastChar = "";
  constructor(private readonly ctx: TagContext) {}

  push(delta: string): TagParseResult {
    const events: CursorTagEvent[] = [];
    let text = "";
    for (const ch of delta) {
      if (this.buf) {
        this.buf += ch;
        if (ch === "]") {
          const ev = parseTag(this.buf.slice(1, -1), this.ctx);
          if (ev) events.push(ev);
          this.buf = "";
          continue;
        }
        if (!couldBeTag(this.buf)) {
          text += this.buf;
          this.buf = "";
        } else if (this.buf.length > MAX_TAG_CHARS) {
          // A tag that never closes is dropped, never spoken.
          this.buf = "";
        }
        continue;
      }
      if (ch === "[") {
        this.buf = "[";
        continue;
      }
      text += ch;
    }
    return { text: this.tidy(text), events };
  }

  end(): TagParseResult {
    const left = this.buf;
    this.buf = "";
    // An unclosed tag-looking tail is dropped; a lone "[" or "[Ab" is text.
    const text = left && !/^\[[A-Z_]{2,12}:/.test(left) ? left : "";
    return { text: this.tidy(text), events: [] };
  }

  /** Collapse the double spaces a removed tag leaves behind (and leading spaces). */
  private tidy(s: string): string {
    let out = "";
    for (const ch of s) {
      if (ch === " " && (this.lastChar === " " || this.lastChar === "" || this.lastChar === "\n")) continue;
      out += ch;
      this.lastChar = ch;
    }
    return out;
  }
}

/** Parse a whole reply at once (tests, non-streaming callers). */
export function parseCursorReply(textIn: string, ctx: TagContext): TagParseResult {
  const p = new CursorTagStream(ctx);
  const a = p.push(textIn);
  const b = p.end();
  return { text: (a.text + b.text).replace(/[ \t]+\n/g, "\n").replace(/ +([.,!?;:])/g, "$1").trim(), events: [...a.events, ...b.events] };
}

// ShapesOS Phase 23 - what the public read-only viewer can render faithfully.
// Pure module (no React, no DB). Two jobs:
//  1. assessSnapshot: decide whether a snapshot has ONLY content the viewer
//     renders. Anything else (tables, images, drawings, section breaks,
//     merged cells, non-text slide elements...) is rejected so a share link
//     is never published with silently dropped content.
//  2. docToBlocks / sheetToGrids / slideToPages: the exact structures the
//     viewer renders, so tests assert real output.

export type Assessment = { ok: true } | { ok: false; reason: string };
const no = (reason: string): Assessment => ({ ok: false, reason });

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : isRec(v) ? Object.keys(v).length > 0 : false;

// Univer text-run style keys the viewer renders (bold, italic, underline,
// strike) or that are purely visual and carry no content (size, font, colors).
const RENDERED_TS = new Set(["bl", "it", "ul", "st"]);
const VISUAL_ONLY_TS = new Set(["fs", "ff", "cl", "bg", "bd", "va", "sc"]);

// Control characters Univer 1.x puts in dataStream (read from the pinned
// @univerjs/core 1.0.2 types, DataStreamTreeTokenType). The viewer renders the
// table cell/row tokens and the hyperlink pair; every other structural token
// means content we do not draw, so the share is refused instead of leaking
// control characters into the page.
const T_TABLE_START = "\u001A", T_ROW_START = "\u001B", T_CELL_START = "\u001C", T_CELL_END = "\u001D", T_ROW_END = "\u000E", T_TABLE_END = "\u000F";
const T_LINK_START = "\u001F", T_LINK_END = "\u001E";
const UNRENDERED_TOKENS = /[\u0000\u0008\u0010-\u0015]/; // docs end, custom block, block and column-group tokens
const OLD_TOKENS = /[\u0002-\u0007]/; // pre-1.x sentinels: never rendered
// Body keys the viewer understands. Any other non-empty key is content we do not draw.
const BODY_KEYS_HANDLED = new Set(["dataStream", "textRuns", "paragraphs", "customRanges", "tables", "renderedPageBreaks"]);

export const SAFE_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];
/** The URL to link to, or null when it is not an absolute http(s)/mailto URL. */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || /[\u0000-\u001F\u007F\s]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    return SAFE_LINK_PROTOCOLS.includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function assessDocBody(doc: unknown, depth = 0, allowTables = true): Assessment {
  if (!isRec(doc)) return no("document has no readable body");
  if (nonEmpty(doc.drawings) || nonEmpty(doc.drawingsOrder)) return no("contains images or drawings");
  const body = doc.body;
  if (!isRec(body)) return no("document has no readable body");
  if (typeof body.dataStream !== "string") return no("document has no text stream");
  if (nonEmpty(body.customBlocks)) return no("contains embedded blocks");
  if (nonEmpty(body.sectionBreaks)) return no("contains section breaks");
  for (const [k, v] of Object.entries(body)) {
    if (!BODY_KEYS_HANDLED.has(k) && k !== "sectionBreaks" && k !== "customBlocks" && nonEmpty(v)) return no(`contains unsupported content (${k})`);
  }
  const stream = body.dataStream;
  if (UNRENDERED_TOKENS.test(stream) || OLD_TOKENS.test(stream)) return no("contains tables or embedded objects");

  // Links: every custom range must be a hyperlink with a safe absolute URL and
  // must line up exactly with a start/end token pair in the stream.
  const ranges = (Array.isArray(body.customRanges) ? body.customRanges : []) as unknown[];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < stream.length; i++) {
    if (stream[i] === T_LINK_START) starts.push(i);
    else if (stream[i] === T_LINK_END) ends.push(i);
  }
  if (ranges.length !== starts.length || starts.length !== ends.length) return no("contains links or custom ranges that cannot be shown faithfully");
  const sorted = ranges.filter(isRec).sort((a, b) => Number(a.startIndex) - Number(b.startIndex));
  if (sorted.length !== ranges.length) return no("contains links or custom ranges that cannot be shown faithfully");
  for (let n = 0; n < sorted.length; n++) {
    const r = sorted[n];
    if (r.rangeType !== 0) return no("contains custom ranges other than links");
    const props = isRec(r.properties) ? r.properties : {};
    if (props.bookmarkId || props.headingId) return no("contains links inside the document");
    if (safeHref(props.url) === null) return no("contains a link that is not a plain web or email address");
    if (r.startIndex !== starts[n] || r.endIndex !== ends[n] || !(starts[n] < ends[n])) return no("contains links whose position does not match the text");
    if (n > 0 && starts[n] < ends[n - 1]) return no("contains overlapping links");
  }

  // Tables: tokens must balance and nest correctly, no merged cells, no nested tables.
  const tableTokens = new RegExp(`[${T_TABLE_START}${T_ROW_START}${T_CELL_START}${T_CELL_END}${T_ROW_END}${T_TABLE_END}]`, "g");
  const toks = stream.match(tableTokens) ?? [];
  if (toks.length > 0) {
    if (!allowTables || depth > 0) return no("contains tables where they cannot be shown");
    const expect: string[] = [];
    let open = 0;
    for (const t of toks) {
      if (t === T_TABLE_START) { if (open > 0) return no("contains nested tables"); open++; expect.push(T_TABLE_END); expect.push("row?"); }
      else if (t === T_ROW_START) { if (open !== 1 || expect[expect.length - 1] !== "row?") return no("contains a malformed table"); expect.pop(); expect.push(T_ROW_END); expect.push("cell?"); }
      else if (t === T_CELL_START) { if (expect[expect.length - 1] !== "cell?") return no("contains a malformed table"); expect.pop(); expect.push(T_CELL_END); }
      else if (t === T_CELL_END) { if (expect.pop() !== T_CELL_END) return no("contains a malformed table"); expect.push("cell?"); }
      else if (t === T_ROW_END) { if (expect[expect.length - 1] !== "cell?") return no("contains a malformed table"); expect.pop(); if (expect.pop() !== T_ROW_END) return no("contains a malformed table"); expect.push("row?"); }
      else if (t === T_TABLE_END) { if (expect[expect.length - 1] !== "row?") return no("contains a malformed table"); expect.pop(); if (expect.pop() !== T_TABLE_END) return no("contains a malformed table"); open--; }
    }
    if (open !== 0 || expect.length !== 0) return no("contains a malformed table");
    const src = isRec(doc.tableSource) ? doc.tableSource : {};
    for (const t of Object.values(src)) {
      const rows = isRec(t) && Array.isArray(t.tableRows) ? t.tableRows : [];
      for (const row of rows) {
        for (const cell of isRec(row) && Array.isArray(row.tableCells) ? row.tableCells : []) {
          if (isRec(cell) && ((Number(cell.rowSpan) || 1) > 1 || (Number(cell.columnSpan) || 1) > 1)) return no("contains merged table cells");
        }
      }
    }
  } else if (nonEmpty(body.tables)) {
    return no("contains tables that cannot be shown faithfully");
  }
  for (const run of Array.isArray(body.textRuns) ? body.textRuns : []) {
    const ts = isRec(run) && isRec(run.ts) ? run.ts : {};
    for (const k of Object.keys(ts)) {
      if (!RENDERED_TS.has(k) && !VISUAL_ONLY_TS.has(k)) return no(`uses unsupported text style "${k}"`);
    }
  }
  return { ok: true };
}

export function assessSnapshot(kind: string, snapshot: unknown): Assessment {
  if (!isRec(snapshot)) return no("empty snapshot");
  if (kind === "doc") return assessDocBody(snapshot);
  if (kind === "sheet") {
    const sheets = snapshot.sheets;
    if (!isRec(sheets)) return no("workbook has no sheets");
    for (const ws of Object.values(sheets)) {
      if (!isRec(ws)) continue;
      if (nonEmpty(ws.mergeData)) return no("contains merged cells");
      if (nonEmpty(ws.drawings) || nonEmpty(ws.drawingsOrder)) return no("contains images or drawings");
      const cells = isRec(ws.cellData) ? ws.cellData : {};
      for (const row of Object.values(cells)) {
        if (!isRec(row)) continue;
        for (const cell of Object.values(row)) {
          if (isRec(cell) && cell.p && (cell.v === undefined || cell.v === null)) return no("contains rich-text cells");
        }
      }
    }
    return { ok: true };
  }
  if (kind === "slide") {
    const body = snapshot.body;
    const pages = isRec(body) ? body.pages : undefined;
    if (!isRec(pages)) return no("deck has no slides");
    for (const page of Object.values(pages)) {
      if (!isRec(page)) continue;
      for (const el of Object.values(isRec(page.pageElements) ? page.pageElements : {})) {
        if (!isRec(el)) continue;
        if (el.type !== 2) return no("contains shapes or images");
        const rich = isRec(el.richText) ? el.richText.rich : undefined;
        const a = assessDocBody(rich, 0, false);
        if (!a.ok) return a;
      }
    }
    return { ok: true };
  }
  return no(`unsupported document kind "${kind}"`);
}

// ---------------------------------------------------------------------------

export interface Seg { text: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean; href?: string }
export interface DocBlock { level: 0 | 1 | 2 | 3; bullet: boolean; segs: Seg[]; /** rows -> cells -> blocks, when this block is a table */ table?: DocBlock[][][] }

const flag = (v: unknown): boolean => v === 1 || (isRec(v) && v.s === 1);

export function docToBlocks(doc: unknown): DocBlock[] {
  const body = (isRec(doc) && isRec(doc.body) ? doc.body : {}) as Rec;
  const stream = typeof body.dataStream === "string" ? body.dataStream : "";
  const runs = (Array.isArray(body.textRuns) ? body.textRuns : []) as Rec[];
  const paras = (Array.isArray(body.paragraphs) ? body.paragraphs : []) as Rec[];
  const links = ((Array.isArray(body.customRanges) ? body.customRanges : []) as Rec[])
    .filter((r) => r.rangeType === 0)
    .map((r) => ({ st: Number(r.startIndex), ed: Number(r.endIndex), href: safeHref(isRec(r.properties) ? r.properties.url : undefined) }));
  const hrefAt = (i: number): string | undefined => {
    for (const l of links) if (l.href && i > l.st && i < l.ed) return l.href;
    return undefined;
  };
  const styleAt = (i: number) => {
    let s = { bold: false, italic: false, underline: false, strike: false };
    for (const r of runs) {
      if (i >= (Number(r.st) || 0) && i < (Number(r.ed) || 0)) {
        const ts = (isRec(r.ts) ? r.ts : {}) as Rec;
        s = {
          bold: s.bold || flag(ts.bl),
          italic: s.italic || flag(ts.it),
          underline: s.underline || flag(ts.ul),
          strike: s.strike || flag(ts.st),
        };
      }
    }
    return s;
  };
  const TABLE_TOKENS = new Set([T_TABLE_START, T_ROW_START, T_CELL_START, T_CELL_END, T_ROW_END, T_TABLE_END]);
  // Containers: the root, or the cell currently open inside a table.
  const root: DocBlock[] = [];
  let target: DocBlock[] = root;
  let table: DocBlock[][][] | null = null;
  let row: DocBlock[][] | null = null;
  let start = 0;
  let pi = 0;
  const flush = (end: number) => {
    const meta = paras[pi] ?? {};
    const pstyle = (isRec(meta.paragraphStyle) ? meta.paragraphStyle : {}) as Rec;
    const m = /heading(\d)/i.exec(String(pstyle.headingId ?? ""));
    const level = (m ? Math.min(3, Math.max(1, Number(m[1]))) : 0) as 0 | 1 | 2 | 3;
    const segs: Seg[] = [];
    for (let i = start; i < end; i++) {
      const ch = stream[i];
      if (ch === T_LINK_START || ch === T_LINK_END) continue;
      const st = styleAt(i);
      const href = hrefAt(i);
      const last = segs[segs.length - 1];
      if (last && last.bold === st.bold && last.italic === st.italic && last.underline === st.underline && last.strike === st.strike && last.href === href) {
        last.text += ch;
      } else segs.push({ text: ch, ...st, ...(href ? { href } : {}) });
    }
    target.push({ level, bullet: isRec(meta.bullet), segs });
    pi++;
    start = end + 1 + (stream[end + 1] === "\n" ? 1 : 0);
  };
  for (let i = 0; i < stream.length; i++) {
    const ch = stream[i];
    if (TABLE_TOKENS.has(ch)) {
      if (i > start && stream.slice(start, i).replace(/[\r\n]/g, "") !== "") flush(i);
      if (ch === T_TABLE_START) { table = []; }
      else if (ch === T_ROW_START && table) { row = []; table.push(row); }
      else if (ch === T_CELL_START && row) { const cell: DocBlock[] = []; row.push(cell); target = cell; }
      else if (ch === T_CELL_END) { target = root; }
      else if (ch === T_ROW_END) { row = null; }
      else if (ch === T_TABLE_END && table) { root.push({ level: 0, bullet: false, segs: [], table }); table = null; target = root; }
      start = i + 1;
      continue;
    }
    if (ch === "\r") flush(i);
  }
  if (start < stream.length && stream.slice(start).replace(/[\r\n\0]/g, "") !== "") flush(stream.length);
  // Drop only trailing empties; interior blank paragraphs are spacing.
  while (root.length && !root[root.length - 1].table && root[root.length - 1].segs.every((s) => s.text.trim() === "") && root[root.length - 1].level === 0) root.pop();
  return root;
}

export interface SheetGrid { name: string; rows: string[][] }

export function sheetToGrids(snapshot: unknown): SheetGrid[] {
  const rec = (isRec(snapshot) ? snapshot : {}) as Rec;
  const sheets = (isRec(rec.sheets) ? rec.sheets : {}) as Record<string, Rec>;
  const order = (Array.isArray(rec.sheetOrder) ? (rec.sheetOrder as string[]) : []).filter((id) => sheets[id]);
  const ids = order.length ? order : Object.keys(sheets);
  return ids.map((id) => {
    const ws = sheets[id];
    const cells = (isRec(ws.cellData) ? ws.cellData : {}) as Record<string, Record<string, Rec>>;
    let maxR = -1;
    let maxC = -1;
    const at = new Map<string, string>();
    for (const [r, cols] of Object.entries(cells)) {
      for (const [c, cell] of Object.entries(cols ?? {})) {
        const v = cell?.v;
        if (v === undefined || v === null || v === "") continue;
        at.set(`${r}:${c}`, String(v));
        maxR = Math.max(maxR, Number(r));
        maxC = Math.max(maxC, Number(c));
      }
    }
    const rows: string[][] = [];
    for (let r = 0; r <= maxR; r++) {
      const row: string[] = [];
      for (let c = 0; c <= maxC; c++) row.push(at.get(`${r}:${c}`) ?? "");
      rows.push(row);
    }
    return { name: typeof ws.name === "string" ? ws.name : "Sheet", rows };
  });
}

export interface SlidePage { title: string; elements: DocBlock[][] }

export function slideToPages(snapshot: unknown): SlidePage[] {
  const body = (isRec(snapshot) && isRec(snapshot.body) ? snapshot.body : {}) as Rec;
  const pages = (isRec(body.pages) ? body.pages : {}) as Record<string, Rec>;
  const order = (Array.isArray(body.pageOrder) ? (body.pageOrder as string[]) : []).filter((id) => pages[id]);
  const ids = order.length ? order : Object.keys(pages);
  return ids.map((id, i) => {
    const p = pages[id];
    const els = Object.values((isRec(p.pageElements) ? p.pageElements : {}) as Record<string, Rec>).sort(
      (a, b) => (Number(a.zIndex) || 0) - (Number(b.zIndex) || 0),
    );
    return {
      title: typeof p.title === "string" && p.title ? p.title : `Slide ${i + 1}`,
      elements: els.map((el) => docToBlocks(isRec(el.richText) ? el.richText.rich : undefined)),
    };
  });
}

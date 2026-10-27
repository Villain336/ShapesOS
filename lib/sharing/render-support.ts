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

function assessDocBody(doc: unknown, depth = 0): Assessment {
  if (!isRec(doc)) return no("document has no readable body");
  if (nonEmpty(doc.drawings) || nonEmpty(doc.drawingsOrder)) return no("contains images or drawings");
  const body = doc.body;
  if (!isRec(body)) return no("document has no readable body");
  if (typeof body.dataStream !== "string") return no("document has no text stream");
  if (nonEmpty(body.tables)) return no("contains tables");
  if (nonEmpty(body.customBlocks)) return no("contains embedded blocks");
  if (nonEmpty(body.sectionBreaks)) return no("contains section breaks");
  if (nonEmpty(body.customRanges)) return no("contains links or custom ranges");
  if (/[\u0002\u0003\u0004\u0005\u0006\u0007\u000e\u000f]/.test(body.dataStream)) return no("contains tables or embedded objects");
  for (const run of Array.isArray(body.textRuns) ? body.textRuns : []) {
    const ts = isRec(run) && isRec(run.ts) ? run.ts : {};
    for (const k of Object.keys(ts)) {
      if (!RENDERED_TS.has(k) && !VISUAL_ONLY_TS.has(k)) return no(`uses unsupported text style "${k}"`);
    }
  }
  void depth;
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
        const a = assessDocBody(rich);
        if (!a.ok) return a;
      }
    }
    return { ok: true };
  }
  return no(`unsupported document kind "${kind}"`);
}

// ---------------------------------------------------------------------------

export interface Seg { text: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean }
export interface DocBlock { level: 0 | 1 | 2 | 3; bullet: boolean; segs: Seg[] }

const flag = (v: unknown): boolean => v === 1 || (isRec(v) && v.s === 1);

export function docToBlocks(doc: unknown): DocBlock[] {
  const body = (isRec(doc) && isRec(doc.body) ? doc.body : {}) as Rec;
  const stream = typeof body.dataStream === "string" ? body.dataStream : "";
  const runs = (Array.isArray(body.textRuns) ? body.textRuns : []) as Rec[];
  const paras = (Array.isArray(body.paragraphs) ? body.paragraphs : []) as Rec[];
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
  const blocks: DocBlock[] = [];
  let start = 0;
  let pi = 0;
  const flush = (end: number) => {
    const meta = paras[pi] ?? {};
    const pstyle = (isRec(meta.paragraphStyle) ? meta.paragraphStyle : {}) as Rec;
    const m = /heading(\d)/i.exec(String(pstyle.headingId ?? ""));
    const level = (m ? Math.min(3, Math.max(1, Number(m[1]))) : 0) as 0 | 1 | 2 | 3;
    const segs: Seg[] = [];
    for (let i = start; i < end; i++) {
      const st = styleAt(i);
      const last = segs[segs.length - 1];
      if (last && last.bold === st.bold && last.italic === st.italic && last.underline === st.underline && last.strike === st.strike) {
        last.text += stream[i];
      } else segs.push({ text: stream[i], ...st });
    }
    blocks.push({ level, bullet: isRec(meta.bullet), segs });
    pi++;
    start = end + 1 + (stream[end + 1] === "\n" ? 1 : 0);
  };
  for (let i = 0; i < stream.length; i++) if (stream[i] === "\r") flush(i);
  if (start < stream.length) flush(stream.length);
  // Drop only trailing empties; interior blank paragraphs are spacing.
  while (blocks.length && blocks[blocks.length - 1].segs.every((s) => s.text.trim() === "") && blocks[blocks.length - 1].level === 0) blocks.pop();
  return blocks;
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

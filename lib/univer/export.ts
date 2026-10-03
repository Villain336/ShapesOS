// Marketr — Phase 14 slice 8: in-house CSV + PDF export for Univer docs.
// No external services, no extra dependencies. CSV follows RFC 4180 quoting.
// PDF is produced by a small embedded writer (Helvetica family only) with a
// brand header and page-number footer, paginated onto A4.

import { csvCell } from "@/lib/csv";
import type { IWorkbookData } from "@univerjs/core";
import type { IDocumentData } from "@univerjs/core";

// ---------------------------------------------------------------- CSV ----


function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/**
 * First worksheet → CSV. Row/col extent is derived from populated cells so
 * sparse grids don't emit trailing empties.
 */
export function exportSheetCsv(snapshot: IWorkbookData, sheetName?: string): string {
  const sheets = snapshot.sheets ?? {};
  const ids = Object.keys(sheets);
  if (ids.length === 0) return "";
  const ws = sheetName
    ? ids.map((id) => sheets[id]).find((s) => s?.name === sheetName) ?? sheets[ids[0]]
    : sheets[ids[0]];
  const cellData = ws?.cellData ?? {};

  let maxRow = -1;
  let maxCol = -1;
  const grid = new Map<string, string>();
  for (const [r, cols] of Object.entries(cellData)) {
    const ri = Number(r);
    if (!Number.isFinite(ri)) continue;
    for (const [c, cell] of Object.entries(cols ?? {})) {
      const ci = Number(c);
      if (!Number.isFinite(ci)) continue;
      const raw = (cell as { v?: unknown })?.v;
      const t = cellText(raw);
      // Encoded here: numbers stay numbers; text is formula-neutralized.
      grid.set(`${ri}:${ci}`, typeof raw === "number" ? csvCell(raw) : csvCell(t));
      if (t !== "") {
        if (ri > maxRow) maxRow = ri;
        if (ci > maxCol) maxCol = ci;
      }
    }
  }
  if (maxRow < 0 || maxCol < 0) return "";

  const lines: string[] = [];
  for (let r = 0; r <= maxRow; r++) {
    const cols: string[] = [];
    for (let c = 0; c <= maxCol; c++) cols.push(grid.get(`${r}:${c}`) ?? "");
    lines.push(cols.join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- PDF ----

interface PdfLine {
  text: string;
  bold: boolean;
  size: number;
  /** Extra space (pt) inserted after this line (paragraph gap). */
  gapAfter: number;
}

const A4_W = 595;
const A4_H = 842;
const MARGIN = 56;
const CONTENT_W = A4_W - MARGIN * 2;
const HEADER_Y = A4_H - 40;
const FOOTER_Y = 40;
const BODY_TOP = A4_H - 72;
const BODY_BOTTOM = 72;

/** Rough Helvetica advance width per char at 1pt (avg over latin text). */
const AVG_ADV = 0.52;

function wrapLine(text: string, size: number): string[] {
  const maxW = CONTENT_W;
  const words = text.split(/(\s+)/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  const spaceW = size * AVG_ADV;
  for (const w of words) {
    const ww = w.length * size * AVG_ADV;
    if (curW + ww > maxW && cur !== "") {
      lines.push(cur.trimEnd());
      cur = "";
      curW = 0;
      if (/^\s+$/.test(w)) continue;
    }
    cur += w;
    curW += ww;
    void spaceW;
  }
  if (cur.trim() !== "" || lines.length === 0) lines.push(cur.trimEnd());
  return lines;
}

interface DocParagraph {
  text: string;
  boldRanges: Array<[number, number]>;
  headingLevel: number; // 0 = body
}

/** Flatten an IDocumentData body into styled paragraphs (headings + bold). */
export function docSnapshotToParagraphs(snapshot: IDocumentData): DocParagraph[] {
  const body = snapshot.body;
  const stream = body?.dataStream ?? "";
  const textRuns = body?.textRuns ?? [];
  const paras = body?.paragraphs ?? [];

  const boldAt = (idx: number): boolean =>
    textRuns.some((r) => idx >= (r.st ?? 0) && idx < (r.ed ?? 0) && (r.ts as { bl?: number })?.bl === 1);

  const parasOut: DocParagraph[] = [];
  let start = 0;
  let paraIdx = 0;
  const push = (end: number) => {
    const text = stream.slice(start, end);
    const headingId = paras[paraIdx]?.paragraphStyle?.headingId ?? "";
    const m = /heading(\d)/i.exec(headingId);
    const headingLevel = m ? Math.min(3, Math.max(1, Number(m[1]))) : 0;
    const boldRanges: Array<[number, number]> = [];
    let rs: number | null = null;
    for (let i = 0; i < text.length; i++) {
      const b = boldAt(start + i);
      if (b && rs === null) rs = i;
      if (!b && rs !== null) { boldRanges.push([rs, i]); rs = null; }
    }
    if (rs !== null) boldRanges.push([rs, text.length]);
    parasOut.push({ text, boldRanges, headingLevel });
    paraIdx++;
    start = end + 1;
  };
  for (let i = 0; i < stream.length; i++) {
    if (stream[i] === "\r") { push(i); }
  }
  if (start < stream.length) push(stream.length);
  return parasOut.filter((p) => p.text.trim() !== "" || p.headingLevel > 0);
}

function paragraphsToLines(paras: DocParagraph[]): PdfLine[] {
  const lines: PdfLine[] = [];
  for (const p of paras) {
    const size = p.headingLevel === 1 ? 20 : p.headingLevel === 2 ? 16 : p.headingLevel === 3 ? 13 : 11;
    const bold = p.headingLevel > 0;
    for (const wrapped of wrapLine(p.text, size)) {
      lines.push({
        text: wrapped,
        bold: bold || p.boldRanges.some(([s, e]) => s < wrapped.length && e > 0),
        size,
        gapAfter: 0,
      });
    }
    if (lines.length > 0) lines[lines.length - 1].gapAfter = p.headingLevel > 0 ? 10 : 6;
  }
  return lines;
}

function pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

interface PdfOpts {
  title?: string;
  brandName?: string;
  /** [r, g, b] 0..1 — brand-600-ish. Defaults to violet. */
  brandColor?: [number, number, number];
}

/** Minimal multi-object PDF builder (catalog/pages/font/contents + xref). */
export function exportDocPdf(snapshot: IDocumentData, opts: PdfOpts = {}): Uint8Array {
  const brand = opts.brandColor ?? [0.486, 0.227, 0.929]; // #7c3aed
  const brandName = opts.brandName ?? "Marketr";
  const title = opts.title ?? "Document";

  const lines = paragraphsToLines(docSnapshotToParagraphs(snapshot));

  // Paginate.
  const pages: PdfLine[][] = [[]];
  let y = BODY_TOP;
  for (const line of lines) {
    const h = line.size * 1.35;
    if (y - h < BODY_BOTTOM && pages[pages.length - 1].length > 0) {
      pages.push([]);
      y = BODY_TOP;
    }
    pages[pages.length - 1].push(line);
    y -= h + line.gapAfter;
  }
  const total = pages.length;

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (s: string | Uint8Array) => {
    const b = typeof s === "string" ? enc.encode(s) : s;
    chunks.push(b);
    pos += b.length;
  };

  push("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");

  const pageObjNums: number[] = [];
  let nextObj = 1;
  const catalogObj = nextObj++;
  const pagesObj = nextObj++;
  const fontReg = nextObj++;
  const fontBold = nextObj++;

  interface PageDef { pageObj: number; contentObj: number; content: string }
  const defs: PageDef[] = [];
  for (let pi = 0; pi < total; pi++) {
    const pageObj = nextObj++;
    const contentObj = nextObj++;
    pageObjNums.push(pageObj);

    const sb: string[] = [];
    // Brand header.
    sb.push(`BT /F2 10 Tf ${brand[0].toFixed(3)} ${brand[1].toFixed(3)} ${brand[2].toFixed(3)} rg ${MARGIN} ${HEADER_Y} Td (${pdfEscape(brandName)}) Tj ET\n`);
    sb.push(`BT /F1 9 Tf 0.45 0.45 0.45 rg ${MARGIN} ${FOOTER_Y} Td (Page ${pi + 1} of ${total}) Tj ET\n`);
    sb.push(`BT /F1 9 Tf 0.45 0.45 0.45 rg ${MARGIN} ${HEADER_Y - 14} Td (${pdfEscape(title)}) Tj ET\n`);

    let ly = BODY_TOP;
    for (const line of pages[pi]) {
      const font = line.bold ? "F2" : "F1";
      // Keep runs single-font per line for v1 (line-level bold is enough).
      sb.push(`BT /${font} ${line.size} Tf 0.12 0.12 0.12 rg ${MARGIN} ${ly.toFixed(1)} Td (${pdfEscape(line.text)}) Tj ET\n`);
      ly -= line.size * 1.35 + line.gapAfter;
    }
    defs.push({ pageObj, contentObj, content: sb.join("") });
  }

  const writeObj = (n: number, body: string | Uint8Array) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    push(body);
    push(`\nendobj\n`);
  };

  writeObj(catalogObj, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);
  writeObj(pagesObj, `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${total} >>`);
  writeObj(fontReg, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  writeObj(fontBold, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);
  for (const d of defs) {
    writeObj(d.pageObj, `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources << /Font << /F1 ${fontReg} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${d.contentObj} 0 R >>`);
    const cb = enc.encode(d.content);
    offsets[d.contentObj] = pos;
    push(`${d.contentObj} 0 obj\n<< /Length ${cb.length} >>\nstream\n`);
    push(cb);
    push(`\nendstream\nendobj\n`);
  }

  const xrefPos = pos;
  const maxObj = nextObj - 1;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${maxObj + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Filename-safe slug for Content-Disposition. */
export function slugifyFilename(name: string, ext: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
  return `${base}.${ext}`;
}

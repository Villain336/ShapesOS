// Marketr — Phase 14 slice 6: Univer snapshot builders + validators.
//
// Pure functions (no DOM, no Univer runtime): build minimal valid Univer
// snapshots server-side (reports-as-sheets, content calendar) and validate
// any snapshot before it is persisted to UniverDoc. The live editor's own
// snapshots come from FWorkbook.save()/FDocument.save() client-side and go
// through the same validateSnapshot() gate on the way in.
//
// Kinds: "sheet" (IWorkbookData), "doc" (IDocumentData), "slide" (ISlideData
// via raw OSS @univerjs/slides + @univerjs/slides-ui — no slides preset exists).

import type { IWorkbookData } from "@univerjs/core";
import type { IDocumentData } from "@univerjs/core";
import type { ISlideData } from "@univerjs/slides";

export const UNIVER_DOC_KINDS = ["sheet", "doc", "slide"] as const;
export type UniverDocKind = (typeof UNIVER_DOC_KINDS)[number];

export function isUniverDocKind(v: unknown): v is UniverDocKind {
  return typeof v === "string" && (UNIVER_DOC_KINDS as readonly string[]).includes(v);
}

const APP_VERSION = "1.0.2";

function cuidish(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

export interface SheetGridInput {
  title: string;
  /** Column headers (first row, bolded). */
  headers: string[];
  /** Data rows; cells may be string | number | null. */
  rows: (string | number | null)[][];
  sheetName?: string;
}

/**
 * Build a minimal IWorkbookData from a 2D grid. Headers land in row 0
 * (bold), data follows. Usable server-side — no Univer runtime needed.
 */
export function buildSheetSnapshot(input: SheetGridInput): IWorkbookData {
  const title = input.title.trim() || "Untitled sheet";
  const headers = input.headers.map((h) => String(h ?? ""));
  const rows = input.rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : c)));

  const sheetId = cuidish("sheet");
  // Cell style `s` references a style id from the workbook `styles` map.
  const cellData: Record<string, Record<string, { v?: string | number | boolean; s?: string }>> = {};

  const put = (r: number, c: number, v: string | number, bold = false) => {
    cellData[String(r)] = cellData[String(r)] ?? {};
    cellData[String(r)][String(c)] = bold ? { v, s: "header" } : { v };
  };

  headers.forEach((h, c) => put(0, c, h, true));
  rows.forEach((row, r) => row.forEach((v, c) => put(r + 1, c, v === "" ? "" : v)));

  return {
    id: cuidish("workbook"),
    name: title,
    appVersion: APP_VERSION,
    locale: "enUS" as unknown as IWorkbookData["locale"],
    styles: {
      header: { bl: 1 },
    },
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: (input.sheetName ?? "Sheet1").slice(0, 31),
        cellData,
        rowCount: Math.max(rows.length + 1, 10),
        columnCount: Math.max(headers.length, 5),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

/** A paragraph with optional bold ranges and heading level (0 = body). */
export interface DocParagraphInput {
  text: string;
  /** [start, end) char offsets into text that render bold. */
  boldRanges?: Array<[number, number]>;
  headingLevel?: 0 | 1 | 2 | 3;
}

export interface DocTextInput {
  title: string;
  /** Paragraphs of plain text or styled paragraph inputs. */
  paragraphs: Array<string | DocParagraphInput>;
  /** Optional heading for the first paragraph. */
  heading?: string;
}

/**
 * Build a minimal IDocumentData from paragraphs. Univer's dataStream
 * terminates every paragraph with \r\n; paragraphs carry startIndex offsets,
 * heading ids (heading1..3), and bold text runs.
 */
export function buildDocSnapshot(input: DocTextInput): IDocumentData {
  const title = input.title.trim() || "Untitled document";
  const norm: DocParagraphInput[] = input.paragraphs.map((p) =>
    typeof p === "string" ? { text: p } : p,
  );
  const paras = input.heading ? [{ text: input.heading, headingLevel: 1 as const }, { text: "" }, ...norm] : norm;

  let offset = 0;
  const paragraphs: Array<{ startIndex: number; paragraphId: string; paragraphStyle?: { headingId: string } }> = [];
  const textRuns: Array<{ st: number; ed: number; ts: { bl: number } }> = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const startIndex = offset;
    const style = p.headingLevel ? { headingId: `heading${p.headingLevel}` } : undefined;
    paragraphs.push(style ? { startIndex, paragraphId: `p${i}`, paragraphStyle: style } : { startIndex, paragraphId: `p${i}` });
    for (const [s, e] of p.boldRanges ?? []) {
      if (e > s) textRuns.push({ st: startIndex + s, ed: startIndex + Math.min(e, p.text.length), ts: { bl: 1 } });
    }
    offset += p.text.length + 2; // + "\r\n"
  }
  const dataStream = paras.map((p) => `${p.text}\r\n`).join("");

  return {
    id: cuidish("doc"),
    title,
    locale: "enUS" as unknown as IDocumentData["locale"],
    documentStyle: {},
    body: {
      dataStream,
      paragraphs,
      textRuns,
    },
  } as IDocumentData;
}

// ---------------------------------------------------------------------------
// Slides (real ISlideData — raw OSS @univerjs/slides + slides-ui, no preset)
// ---------------------------------------------------------------------------

/** One slide's content. Strings stay supported for the slice 6/7/8 stubs. */
export interface SlideInput {
  title: string;
  /** Body text; blank lines separate paragraphs. */
  body?: string;
}

export interface SlideDeckInput {
  title: string;
  slides: Array<string | SlideInput>;
}

const SLIDE_W = 960;
const SLIDE_H = 540;

/**
 * Build a real ISlideData deck: each slide is a page with a title textbox
 * and a body textbox (rich text via the shared doc builder). 16:9, white
 * background. The OSS slides UI renders this without masters/layouts.
 */
export function buildSlideSnapshot(input: SlideDeckInput): ISlideData {
  const title = input.title.trim() || "Untitled deck";
  const slides: SlideInput[] = input.slides.map((s) =>
    typeof s === "string" ? { title: s.slice(0, 120), body: s } : s,
  );

  const pages: Record<string, unknown> = {};
  const pageOrder: string[] = [];
  slides.forEach((s, i) => {
    const pageId = `page_${i}`;
    pageOrder.push(pageId);
    const slideTitle = s.title.trim() || `Slide ${i + 1}`;
    const bodyParas = (s.body ?? "")
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t !== "");

    const titleEl = `el_${i}_title`;
    const bodyEl = `el_${i}_body`;
    pages[pageId] = {
      id: pageId,
      pageType: 0, // PageType.SLIDE
      zIndex: i,
      title: slideTitle,
      description: "",
      pageBackgroundFill: { rgb: "#FFFFFF" },
      pageElements: {
        [titleEl]: {
          id: titleEl,
          zIndex: 0,
          left: 48,
          top: 32,
          width: SLIDE_W - 96,
          height: 96,
          title: "Title",
          description: "",
          type: 2, // PageElementType.TEXT
          richText: {
            rich: buildDocSnapshot({
              title: slideTitle,
              paragraphs: [{ text: slideTitle, headingLevel: 1, boldRanges: [[0, slideTitle.length]] }],
            }),
          },
        },
        [bodyEl]: {
          id: bodyEl,
          zIndex: 1,
          left: 48,
          top: 150,
          width: SLIDE_W - 96,
          height: SLIDE_H - 198,
          title: "Body",
          description: "",
          type: 2, // PageElementType.TEXT
          richText: {
            rich: buildDocSnapshot({
              title: slideTitle,
              paragraphs: bodyParas.length > 0 ? bodyParas : [""],
            }),
          },
        },
      },
    };
  });

  return {
    id: cuidish("slide"),
    title,
    pageSize: { width: SLIDE_W, height: SLIDE_H },
    body: { pages, pageOrder },
  } as unknown as ISlideData;
}

// ---------------------------------------------------------------------------
// Validation — the persist gate
// ---------------------------------------------------------------------------

export interface SnapshotValidation {
  ok: boolean;
  errors: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateSnapshot(kind: UniverDocKind, snapshot: unknown): SnapshotValidation {
  const errors: string[] = [];
  if (!isRecord(snapshot)) {
    return { ok: false, errors: ["snapshot must be a JSON object"] };
  }
  if (typeof snapshot.id !== "string" || !snapshot.id) errors.push("snapshot.id is required");

  if (kind === "sheet") {
    if (typeof snapshot.name !== "string") errors.push("sheet snapshot.name is required");
    if (!isRecord(snapshot.sheets) || Object.keys(snapshot.sheets).length === 0) {
      errors.push("sheet snapshot.sheets must be a non-empty map");
    }
    if (!Array.isArray(snapshot.sheetOrder)) errors.push("sheet snapshot.sheetOrder is required");
  } else if (kind === "doc") {
    if (!isRecord(snapshot.documentStyle)) errors.push("doc snapshot.documentStyle is required");
    const body = snapshot.body as Record<string, unknown> | undefined;
    if (!isRecord(body) || typeof body.dataStream !== "string") {
      errors.push("doc snapshot.body.dataStream is required");
    }
  } else {
    // slide: real ISlideData (pageSize + body.pages); the slice 6/7/8 minimal
    // stub shape ({ slides: [...] }) is still accepted so older docs load.
    const slideBody = snapshot.body as Record<string, unknown> | undefined;
    const pages = slideBody?.pages;
    if (pages) {
      if (!isRecord(pages) || Object.keys(pages).length === 0) {
        errors.push("slide snapshot.body.pages must be a non-empty object");
      }
    } else if (!Array.isArray(snapshot.slides)) {
      errors.push("slide snapshot needs body.pages or slides");
    }
  }

  // Size guard: snapshots are JSONB; refuse absurd payloads before they hit the DB.
  const bytes = JSON.stringify(snapshot).length;
  const MAX_BYTES = 10 * 1024 * 1024;
  if (bytes > MAX_BYTES) errors.push(`snapshot exceeds ${MAX_BYTES} bytes (${bytes})`);

  return { ok: errors.length === 0, errors };
}

/** Small log-safe summary (never the full snapshot). */
export function snapshotSummary(snapshot: unknown): { id?: string; bytes: number } {
  const bytes = JSON.stringify(snapshot ?? null).length;
  const id = isRecord(snapshot) && typeof snapshot.id === "string" ? snapshot.id : undefined;
  return { ...(id ? { id } : {}), bytes };
}

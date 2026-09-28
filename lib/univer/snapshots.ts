// Marketr — Phase 14 slice 6: Univer snapshot builders + validators.
//
// Pure functions (no DOM, no Univer runtime): build minimal valid Univer
// snapshots server-side (reports-as-sheets, content calendar) and validate
// any snapshot before it is persisted to UniverDoc. The live editor's own
// snapshots come from FWorkbook.save()/FDocument.save() client-side and go
// through the same validateSnapshot() gate on the way in.
//
// Kinds: "sheet" (IWorkbookData), "doc" (IDocumentData), "slide"
// (minimal slide payload — full slide embedding is slice 9).

import type { IWorkbookData } from "@univerjs/core";
import type { IDocumentData } from "@univerjs/core";

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

export interface DocTextInput {
  title: string;
  /** Paragraphs of plain text; empty strings become blank lines. */
  paragraphs: string[];
  /** Optional heading for the first paragraph. */
  heading?: string;
}

/**
 * Build a minimal IDocumentData from plain paragraphs. Univer's dataStream
 * terminates every paragraph with \r\n; paragraphs carry startIndex offsets.
 */
export function buildDocSnapshot(input: DocTextInput): IDocumentData {
  const title = input.title.trim() || "Untitled document";
  const paras = input.heading ? [input.heading, "", ...input.paragraphs] : input.paragraphs;

  let offset = 0;
  const paragraphs = paras.map((p, i) => {
    const startIndex = offset;
    offset += p.length + 2; // + "\r\n"
    return { startIndex, paragraphId: `p${i}` };
  });
  const dataStream = paras.map((p) => `${p}\r\n`).join("");

  return {
    id: cuidish("doc"),
    title,
    locale: "enUS" as unknown as IDocumentData["locale"],
    documentStyle: {},
    body: {
      dataStream,
      paragraphs,
      textRuns: [],
    },
  } as IDocumentData;
}

// ---------------------------------------------------------------------------
// Slides (minimal — full embedding is slice 9)
// ---------------------------------------------------------------------------

export interface SlideDeckInput {
  title: string;
  /** One string per slide (title/body text). */
  slides: string[];
}

/**
 * Minimal slide payload. The v1 slide surface (slice 9) may upgrade this to
 * a real Univer slide unit; validateSnapshot() accepts this shape so docs
 * created today keep working.
 */
export function buildSlideSnapshot(input: SlideDeckInput): Record<string, unknown> {
  return {
    id: cuidish("slide"),
    title: input.title.trim() || "Untitled deck",
    appVersion: APP_VERSION,
    slides: input.slides.map((text, i) => ({
      id: `slide_${i}`,
      title: typeof text === "string" ? text.slice(0, 120) : `Slide ${i + 1}`,
      body: typeof text === "string" ? text : "",
    })),
  };
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
    // slide: minimal shape (slice 9 may harden)
    if (!Array.isArray(snapshot.slides)) errors.push("slide snapshot.slides is required");
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

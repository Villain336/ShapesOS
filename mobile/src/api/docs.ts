// ShapesOS mobile - Office docs on the phone (pure: no React Native imports,
// so vitest covers it). Talks to the SAME routes as the web app:
//   GET   /api/office/docs[?kind=doc]       -> { docs: [{ id, kind, title, version, updatedAt, ... }] }  (no snapshots)
//   GET   /api/office/docs/[id]             -> { doc: { ..., snapshot, version } }
//   PATCH /api/office/docs/[id] { snapshot, expectedVersion } -> { doc }   (editor+; 409 on a version conflict)
//
// Editing is deliberately narrow. Only a "plain" text document - paragraphs of
// unformatted text and nothing else - is editable here, because the phone
// rewrites the whole paragraph stream. Anything else (bold/italic runs,
// headings, lists, links, tables, images, sections, other kinds) opens
// read-only with the reason, so a phone save can never flatten or drop
// structure. The server still decides who may save and rejects stale versions.

import { OsApiError, type OsClientOptions } from "./os";

export interface DocListItem {
  id: string;
  kind: "doc" | "sheet" | "slide";
  title: string;
  version: number;
  updatedAt: string;
}

export interface DocRecord extends DocListItem {
  snapshot: unknown;
}

async function request<T>(opts: OsClientOptions, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { ...opts.authHeaders(), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) message = b.error;
    } catch {
      /* keep the status message */
    }
    throw new OsApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export async function fetchDocs(opts: OsClientOptions): Promise<DocListItem[]> {
  const r = await request<{ docs?: DocListItem[] }>(opts, "/api/office/docs?kind=doc");
  return r.docs ?? [];
}

export async function fetchDoc(opts: OsClientOptions, id: string): Promise<DocRecord> {
  const r = await request<{ doc: DocRecord }>(opts, `/api/office/docs/${encodeURIComponent(id)}`);
  return r.doc;
}

export class DocConflictError extends Error {
  constructor() {
    super("This document changed somewhere else since you opened it. Nothing was saved.");
  }
}

/** Save a new snapshot against the version the phone opened. A 409 is a DocConflictError; nothing is overwritten. */
export async function saveDocSnapshot(opts: OsClientOptions, id: string, snapshot: unknown, expectedVersion: number): Promise<DocRecord> {
  try {
    const r = await request<{ doc: DocRecord }>(opts, `/api/office/docs/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { snapshot, expectedVersion },
    });
    return r.doc;
  } catch (e) {
    if (e instanceof OsApiError && e.status === 409) throw new DocConflictError();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Plain-text documents
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : isRec(v) ? Object.keys(v).length > 0 : false);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
// Body keys that are free to differ: the stream and the paragraph map are
// rewritten; textRuns must be empty (checked separately).
const BODY_REWRITTEN = new Set(["dataStream", "paragraphs", "textRuns"]);
const PARA_KEYS_OK = new Set(["startIndex", "paragraphId"]);

export type PlainDoc = { editable: true; lines: string[] } | { editable: false; reason: string };

const no = (reason: string): PlainDoc => ({ editable: false, reason });

/** startIndex convention of the existing paragraph map: the paragraph's first char, or its closing CR. */
function paragraphConvention(lines: string[], paras: Rec[]): "start" | "cr" | null {
  const fits = (conv: "start" | "cr") => {
    let off = 0;
    for (let i = 0; i < lines.length; i++) {
      const want = conv === "start" ? off : off + lines[i]!.length;
      if (Number(paras[i]!.startIndex) !== want) return false;
      off += lines[i]!.length + 2;
    }
    return true;
  };
  if (fits("start")) return "start";
  if (fits("cr")) return "cr";
  return null;
}

/** Decide whether a doc snapshot is plain paragraphs the phone may edit, and read its lines. */
export function readPlainDoc(kind: string, snapshot: unknown): PlainDoc {
  if (kind !== "doc") return no(`${kind === "sheet" ? "Spreadsheets" : kind === "slide" ? "Slide decks" : "This kind of file"} can only be viewed on the phone`);
  if (!isRec(snapshot)) return no("The document has no readable content");
  if (nonEmpty(snapshot.drawings) || nonEmpty(snapshot.drawingsOrder)) return no("Contains images or drawings");
  const body = snapshot.body;
  if (!isRec(body) || typeof body.dataStream !== "string") return no("The document has no text stream");
  for (const [k, v] of Object.entries(body)) {
    if (BODY_REWRITTEN.has(k)) continue;
    if (nonEmpty(v)) return no(k === "tables" ? "Contains tables" : k === "customRanges" ? "Contains links" : k === "sectionBreaks" ? "Contains section breaks" : "Contains embedded content");
  }
  if (nonEmpty(body.textRuns)) return no("Has bold, italic or other text formatting");
  const stream = body.dataStream;
  if (!/^(?:[^\r\n]*\r\n)*$/.test(stream) || CONTROL.test(stream)) return no("Has a paragraph layout the phone cannot edit safely");
  const lines = stream === "" ? [""] : stream.slice(0, -2).split("\r\n");
  const paras = Array.isArray(body.paragraphs) ? (body.paragraphs as unknown[]) : [];
  const emptyDoc = stream === "" && paras.length === 0;
  if (!emptyDoc && (paras.length !== lines.length || !paras.every(isRec))) return no("Has a paragraph layout the phone cannot edit safely");
  for (const p of paras as Rec[]) {
    for (const k of Object.keys(p)) {
      if (!PARA_KEYS_OK.has(k)) return no(k === "bullet" ? "Contains lists" : k === "paragraphStyle" ? "Has headings or paragraph styles" : "Has paragraph formatting");
    }
  }
  if (stream !== "" && !paragraphConvention(lines, paras as Rec[])) return no("Has a paragraph layout the phone cannot edit safely");
  return { editable: true, lines };
}

export const plainText = (lines: string[]): string => lines.join("\n");

/**
 * The snapshot after replacing the document's text. Everything outside the
 * paragraph stream is carried over untouched; existing paragraph ids are kept
 * in order. Throws if the source is not a plain doc or the text is unusable.
 */
export function rebuildPlainDoc(snapshot: unknown, text: string): unknown {
  const src = readPlainDoc("doc", snapshot);
  if (!src.editable) throw new Error(`Not editable on the phone: ${src.reason}`);
  const next = text.replace(/\r\n?/g, "\n");
  if (CONTROL.test(next)) throw new Error("The text contains characters the document cannot hold.");
  const lines = next.split("\n");
  const snap = snapshot as Rec;
  const body = snap.body as Rec;
  const oldParas = (Array.isArray(body.paragraphs) ? body.paragraphs : []) as Rec[];
  const oldLines = src.lines;
  const conv = oldLines.length === 1 && oldLines[0] === "" ? "start" : paragraphConvention(oldLines, oldParas);
  let off = 0;
  const paragraphs = lines.map((l, i) => {
    const startIndex = conv === "cr" ? off + l.length : off;
    off += l.length + 2;
    const prev = oldParas[i];
    return { ...(prev ?? {}), startIndex, paragraphId: typeof prev?.paragraphId === "string" ? prev.paragraphId : `p${i}` };
  });
  return {
    ...snap,
    body: { ...body, dataStream: lines.map((l) => `${l}\r\n`).join(""), paragraphs, textRuns: [] },
  };
}

/** Read-only text of any doc snapshot (formatting dropped for display only; never saved back). */
export function previewText(snapshot: unknown): string {
  const body = isRec(snapshot) && isRec(snapshot.body) ? snapshot.body : null;
  const stream = body && typeof body.dataStream === "string" ? body.dataStream : "";
  return stream.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\n$/, "");
}

// Marketr — Dataset Builder slice 1: file extraction.
// Upload ingestion for PDF, DOCX, CSV, MD. No new npm dependencies:
// DOCX rides on adm-zip (already in the tree); PDF uses a small,
// documented-subset text extractor (no encryption, FlateDecode streams
// with literal Tj/TJ string operators); CSV and MD are hand-parsed.

import { inflateSync } from "node:zlib";
import AdmZip from "adm-zip";
import { DatasetBuilderError } from "./types";

export type UploadFileKind = "pdf" | "docx" | "csv" | "md";

export interface ExtractedUpload {
  kind: UploadFileKind;
  text: string;
  mimeType: string;
  /** Best-effort title found inside the file, if any. */
  title: string | null;
}

const EXT_TO_KIND: Record<string, UploadFileKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".csv": "csv",
  ".md": "md",
  ".markdown": "md",
};

export function kindForFilename(filename: string): UploadFileKind {
  const lower = filename.toLowerCase();
  for (const [ext, kind] of Object.entries(EXT_TO_KIND)) {
    if (lower.endsWith(ext)) return kind;
  }
  throw new DatasetBuilderError(
    "UNSUPPORTED_FILE_TYPE",
    `unsupported upload type for "${filename}": PDF, DOCX, CSV, and MD only`,
  );
}

/**
 * Extract text from an uploaded file. Returns the extracted text plus a
 * title hint; throws UNSUPPORTED_FILE_TYPE / EXTRACTION_FAILED.
 */
export function extractTextFromUpload(
  filename: string,
  bytes: Uint8Array,
): ExtractedUpload {
  const kind = kindForFilename(filename);
  try {
    switch (kind) {
      case "pdf":
        return extractPdf(bytes);
      case "docx":
        return extractDocx(bytes);
      case "csv":
        return extractCsv(Buffer.from(bytes).toString("utf8"));
      case "md":
        return extractMarkdown(Buffer.from(bytes).toString("utf8"));
    }
  } catch (err) {
    if (err instanceof DatasetBuilderError) throw err;
    throw new DatasetBuilderError(
      "EXTRACTION_FAILED",
      `could not extract text from "${filename}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// ---------------------------------------------------------------- PDF ---
// Minimal extractor for the subset slice 1 promises: unencrypted PDFs
// whose content streams are FlateDecode-encoded with literal-string
// text-showing operators (Tj / TJ). Anything else surfaces as
// EXTRACTION_FAILED with the reason — never silent garbage.

function extractPdf(bytes: Uint8Array): ExtractedUpload {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new DatasetBuilderError("EXTRACTION_FAILED", "not a PDF file");
  }
  const parts: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const raw = buf.toString("latin1");
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    let data = Buffer.from(match[1], "latin1");
    // Only handle FlateDecode content streams.
    const dictStart = raw.lastIndexOf("<<", match.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, match.index) : "";
    if (!/FlateDecode/.test(dict)) continue;
    try {
      data = inflateSync(data);
    } catch {
      continue;
    }
    parts.push(extractPdfTextOps(data.toString("latin1")));
  }
  const text = parts.join("\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) {
    throw new DatasetBuilderError(
      "EXTRACTION_FAILED",
      "no extractable text found (encrypted, scanned-image, or unsupported encoding)",
    );
  }
  return { kind: "pdf", text, mimeType: "application/pdf", title: null };
}

/** Pull literal strings out of Tj / TJ text-showing operators. */
function extractPdfTextOps(content: string): string {
  const out: string[] = [];
  const opRe =
    /(\((?:\\.|[^\\()])*\)(?:\s*\((?:\\.|[^\\()])*\))*)\s*T[Jj]|\[((?:[^\[\]]|\[(?:[^\[\]])*\])*)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = opRe.exec(content)) !== null) {
    const group = m[1] ?? m[2] ?? "";
    const strings = [...group.matchAll(/\((?:\\.|[^\\()])*\)/g)].map((s) =>
      unescapePdfString(s[0].slice(1, -1)),
    );
    if (strings.length) out.push(strings.join(""));
  }
  return out.join(" ");
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf])/g, (_, c: string) =>
      ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c] ?? c,
    )
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\(\d{1,3})/g, (_, oct: string) =>
      String.fromCharCode(parseInt(oct, 8)),
    );
}

// --------------------------------------------------------------- DOCX ---

function extractDocx(bytes: Uint8Array): ExtractedUpload {
  const zip = new AdmZip(Buffer.from(bytes));
  const entry = zip.getEntry("word/document.xml");
  if (!entry) {
    throw new DatasetBuilderError(
      "EXTRACTION_FAILED",
      "not a DOCX file (missing word/document.xml)",
    );
  }
  const xml = entry.getData().toString("utf8");
  const paras = [...xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) =>
    [...p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((t) => decodeXmlEntities(t[1]))
      .join(""),
  );
  const text = paras
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) {
    throw new DatasetBuilderError(
      "EXTRACTION_FAILED",
      "no extractable text found in DOCX",
    );
  }
  return {
    kind: "docx",
    text,
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    title: null,
  };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------- CSV ---

function extractCsv(text: string): ExtractedUpload {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) {
    throw new DatasetBuilderError("EXTRACTION_FAILED", "CSV is empty");
  }
  const [header, ...body] = rows;
  const lines = body.map((row) =>
    header
      .map((col, i) => `${col.trim()}: ${row[i]?.trim() ?? ""}`)
      .join(" | "),
  );
  return {
    kind: "csv",
    text: lines.join("\n"),
    mimeType: "text/csv",
    title: null,
  };
}

/** Small RFC-4180-ish parser: quoted fields, escaped quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

// ------------------------------------------------------------------ MD ---

function extractMarkdown(text: string): ExtractedUpload {
  // Strip YAML frontmatter; keep the body verbatim (structure is slice 2's job).
  const fm = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const body = fm ? text.slice(fm[0].length) : text;
  const trimmed = body.trim();
  if (!trimmed) {
    throw new DatasetBuilderError("EXTRACTION_FAILED", "markdown file is empty");
  }
  const titleMatch = trimmed.match(/^#\s+(.+)$/m);
  return {
    kind: "md",
    text: trimmed,
    mimeType: "text/markdown",
    title: titleMatch ? titleMatch[1].trim() : null,
  };
}

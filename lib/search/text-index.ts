// ShapesOS — Phase 18.1 (WS=find): the text inside files and Office docs.
//
// Spotlight finds words INSIDE an uploaded PDF, a DOCX, a spreadsheet, a
// CSV / Markdown / text file, or an Office doc. This module extracts that
// text with the extractors the app already has —
//   PDF / DOCX / CSV / Markdown   lib/datasetbuilder/extract.ts
//   XLSX                          lib/documents/xlsx.ts readXlsx (exceljs)
//   Office docs / sheets / decks  lib/univer/export.ts
//   plain text, JSON, HTML        here (tags stripped)
// — splits it into chunks, and stores them in search_texts /
// search_text_chunks (FORCE RLS): each chunk gets a GENERATED full-text
// vector and, for the first EMBED_CHUNKS chunks, a MiniLM embedding.
//
// When it runs:
//   * on upload — lib/filesystem/service.ts writeFile() calls
//     scheduleFileTextIndex() after the row commits (in the background:
//     an upload never waits for extraction);
//   * on Office save — lib/univer/docs.ts create / save schedule the doc;
//   * for everything older — scripts/search/backfill-text-index.mts
//     (idempotent: a record whose content hash is unchanged is skipped).
// A new version of a file (WorkspaceFileVersion, 18.2) calls
// indexFileText() for the same file id: the hash differs, so it re-extracts
// and replaces the chunks.
//
// Honest failure: an unsupported type, an encrypted/scanned PDF or a parse
// error is recorded on the row (status + error) — never indexed as garbage.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getStorageAdapter } from "@/lib/filesystem/storage";
import { extractTextFromUpload } from "@/lib/datasetbuilder/extract";
import { readXlsx } from "@/lib/documents/xlsx";
import { toVectorLiteral, embedText } from "@/lib/substrate/memory/embed";
import { log } from "@/lib/observability/log";
import { spotlightEmbedderLoaded } from "./semantic";

export const TEXT_INDEX_LIMITS = {
  /** Files larger than this are recorded as too_large (the upload cap is 25 MB). */
  maxFileBytes: 25 * 1024 * 1024,
  /** Characters of extracted text kept (content column + chunks). */
  maxChars: 400_000,
  /** Target chunk size in characters (split on paragraph / sentence ends). */
  chunkChars: 1_000,
  /** Chunks embedded per record (the rest are full-text only). */
  embedChunks: 48,
} as const;

export type TextStatus = "indexed" | "empty" | "unsupported" | "failed" | "too_large";

export interface Extracted {
  status: TextStatus;
  text: string;
  extractor: string | null;
  error?: string;
}

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|x-ndjson))/;

/** Strip markup to readable text (HTML / XML). */
export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Extract the text of a file's bytes. Pure apart from the parsers (no I/O). */
export async function extractFileText(filename: string, mimeType: string, bytes: Buffer): Promise<Extracted> {
  const lower = filename.toLowerCase();
  if (bytes.length > TEXT_INDEX_LIMITS.maxFileBytes) return { status: "too_large", text: "", extractor: null };
  try {
    if (/\.(pdf|docx|csv|md|markdown)$/.test(lower)) {
      const out = extractTextFromUpload(filename, new Uint8Array(bytes));
      return { status: out.text.trim() ? "indexed" : "empty", text: out.text, extractor: out.kind };
    }
    if (/\.xlsx$/.test(lower) || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      const sheets = await readXlsx(bytes, 5_000);
      const text = sheets
        .map((s) => [`# ${s.name}`, ...s.rows.map((r) => r.filter((c) => c !== null && c !== undefined && c !== "").map(String).join(" | "))].join("\n"))
        .join("\n\n");
      return { status: text.replace(/#.*$/gm, "").trim() ? "indexed" : "empty", text, extractor: "xlsx" };
    }
    if (/\.(html?|xml|svg)$/.test(lower) || /^(text\/html|application\/xml|text\/xml)/.test(mimeType)) {
      const text = stripTags(bytes.toString("utf8"));
      return { status: text.trim() ? "indexed" : "empty", text, extractor: "html" };
    }
    if (/\.(txt|json|ya?ml|log|tsv|ndjson|ts|js|py|sql)$/.test(lower) || TEXT_MIME.test(mimeType)) {
      const text = bytes.toString("utf8");
      if (/\u0000/.test(text.slice(0, 2_000))) return { status: "unsupported", text: "", extractor: null, error: "binary content" };
      return { status: text.trim() ? "indexed" : "empty", text, extractor: "text" };
    }
    return { status: "unsupported", text: "", extractor: null };
  } catch (err) {
    return { status: "failed", text: "", extractor: null, error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) };
  }
}

/** The searchable text of an Office (Univer) doc / sheet / deck snapshot. */
export async function extractUniverText(kind: string, snapshot: unknown): Promise<Extracted> {
  try {
    const { docSnapshotToParagraphs, sheetSnapshotToSheets } = await import("@/lib/univer/export");
    let text = "";
    if (kind === "note") {
      // Phase 18.2 (WS=content): notes are Tiptap JSON (lib/notes/content.ts).
      const { noteText } = await import("@/lib/notes/content");
      text = noteText(snapshot);
    } else if (kind === "doc") {
      text = docSnapshotToParagraphs(snapshot as Parameters<typeof docSnapshotToParagraphs>[0]).map((p) => p.text).join("\n");
    } else if (kind === "sheet") {
      text = sheetSnapshotToSheets(snapshot as Parameters<typeof sheetSnapshotToSheets>[0])
        .map((s) => [`# ${s.name}`, ...s.rows.map((r) => r.filter((c) => c !== null && c !== "").map(String).join(" | "))].join("\n"))
        .join("\n\n");
    } else {
      // Decks (and anything else): every text run Univer stores as a dataStream.
      const out: string[] = [];
      const walk = (v: unknown, depth: number) => {
        if (depth > 40 || out.length > 5_000) return;
        if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
        else if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (k === "dataStream" && typeof x === "string") out.push(x);
            else walk(x, depth + 1);
          }
        }
      };
      walk(snapshot, 0);
      text = out.join("\n");
    }
    text = text.replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
    return { status: text.replace(/#.*$/gm, "").trim() ? "indexed" : "empty", text, extractor: `univer-${kind}` };
  } catch (err) {
    return { status: "failed", text: "", extractor: `univer-${kind}`, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

/**
 * Split text into ~chunkChars pieces, breaking at paragraph, then sentence,
 * then word boundaries. Whitespace-normalized; empty pieces dropped. Pure.
 */
export function chunkText(text: string, size: number = TEXT_INDEX_LIMITS.chunkChars, maxChars: number = TEXT_INDEX_LIMITS.maxChars): string[] {
  const clean = text.replace(/\u0000/g, "").replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim().slice(0, maxChars);
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > 0) {
    if (rest.length <= size) {
      chunks.push(rest.trim());
      break;
    }
    const window = rest.slice(0, size + 1);
    let cut = window.lastIndexOf("\n\n");
    if (cut < size * 0.5) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    if (cut < size * 0.5) cut = window.lastIndexOf(" ");
    if (cut < size * 0.3) cut = size;
    chunks.push(rest.slice(0, cut + (rest[cut] === "." ? 1 : 0)).trim());
    rest = rest.slice(cut + 1);
  }
  return chunks.filter((c) => c.length > 0);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type Embed = (text: string) => Promise<number[]>;

export interface IndexOptions {
  /** Re-extract even when the content hash is unchanged. */
  force?: boolean;
  /** Embed chunks now (default true); false leaves embeddings for later. */
  embed?: boolean;
  /** Test seam: the embedder (default the local MiniLM). */
  embedder?: Embed;
}

export interface IndexResult {
  status: TextStatus | "unchanged" | "missing";
  chunks: number;
  embedded: number;
}

interface Target {
  workspaceId: string;
  source: "file" | "doc";
  fileId?: string;
  univerDocId?: string;
}

/** Write (or replace) one record's text + chunks. Idempotent on content hash. */
async function writeIndex(target: Target, extracted: Extracted, opts: IndexOptions): Promise<IndexResult> {
  const text = extracted.text.slice(0, TEXT_INDEX_LIMITS.maxChars);
  const hash = sha256(`${extracted.status}\n${text}`);
  const key = target.fileId ? { fileId: target.fileId } : { univerDocId: target.univerDocId! };
  const existing = await withWorkspaceScope(target.workspaceId, (tx) =>
    tx.searchText.findFirst({ where: { workspaceId: target.workspaceId, ...key }, select: { id: true, contentSha256: true, embeddedCount: true, chunkCount: true } }),
  );
  if (existing && existing.contentSha256 === hash && !opts.force) {
    const missingEmbeds = opts.embed !== false ? await embedPending(target.workspaceId, existing.id, opts.embedder) : 0;
    return { status: "unchanged", chunks: existing.chunkCount, embedded: existing.embeddedCount + missingEmbeds };
  }
  const chunks = extracted.status === "indexed" ? chunkText(text) : [];
  const id = await withWorkspaceScope(
    target.workspaceId,
    async (tx) => {
      const data = {
        workspaceId: target.workspaceId,
        source: target.source,
        status: extracted.status,
        extractor: extracted.extractor,
        contentSha256: hash,
        content: extracted.status === "indexed" ? text : null,
        charCount: text.length,
        chunkCount: chunks.length,
        embeddedCount: 0,
        truncated: extracted.text.length > TEXT_INDEX_LIMITS.maxChars,
        error: extracted.error ?? null,
        indexedAt: new Date(),
      };
      const row = existing
        ? await tx.searchText.update({ where: { id: existing.id, workspaceId: target.workspaceId }, data })
        : await tx.searchText.create({ data: { ...data, ...key } });
      await tx.searchTextChunk.deleteMany({ where: { workspaceId: target.workspaceId, searchTextId: row.id } });
      if (chunks.length) {
        await tx.searchTextChunk.createMany({
          data: chunks.map((body, idx) => ({ workspaceId: target.workspaceId, searchTextId: row.id, idx, body })),
        });
      }
      return row.id;
    },
    { timeoutMs: 30_000 },
  );
  const embedded = opts.embed !== false && chunks.length ? await embedPending(target.workspaceId, id, opts.embedder) : 0;
  return { status: extracted.status, chunks: chunks.length, embedded };
}

/**
 * Embed a record's chunks that have no embedding yet (the first
 * EMBED_CHUNKS by position). Never throws: a model that can't load leaves
 * them NULL (full text still works) and logs why.
 */
export async function embedPending(workspaceId: string, searchTextId: string, embedder: Embed = embedText): Promise<number> {
  const pending = await withWorkspaceScope(workspaceId, (tx) =>
    tx.$queryRaw<Array<{ id: string; body: string }>>`
      SELECT id, body FROM search_text_chunks
       WHERE workspace_id = ${workspaceId} AND search_text_id = ${searchTextId}
         AND embedding IS NULL AND idx < ${TEXT_INDEX_LIMITS.embedChunks}
       ORDER BY idx`,
  );
  let done = 0;
  for (const c of pending) {
    let vec: number[];
    try {
      vec = await embedder(c.body);
    } catch (err) {
      log.warn("search text embedding skipped", { error: err instanceof Error ? err.message : String(err) });
      break;
    }
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.$executeRaw`UPDATE search_text_chunks SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${c.id} AND workspace_id = ${workspaceId}`,
    );
    done++;
  }
  if (done) {
    await withWorkspaceScope(workspaceId, (tx) =>
      tx.$executeRaw`UPDATE search_texts SET embedded_count = (SELECT count(*) FROM search_text_chunks WHERE search_text_id = ${searchTextId} AND workspace_id = ${workspaceId} AND embedding IS NOT NULL), updated_at = now() WHERE id = ${searchTextId} AND workspace_id = ${workspaceId}`,
    );
  }
  return done;
}

/** Index one workspace file's text (idempotent; re-extracts when its bytes changed). */
export async function indexFileText(workspaceId: string, fileId: string, opts: IndexOptions = {}): Promise<IndexResult> {
  const row = await prisma.workspaceFile.findFirst({
    where: { id: fileId, workspaceId, trashedAt: null },
    select: { id: true, filename: true, mimeType: true, sizeBytes: true, storageKey: true },
  });
  if (!row) return { status: "missing", chunks: 0, embedded: 0 };
  let extracted: Extracted;
  if (row.sizeBytes > TEXT_INDEX_LIMITS.maxFileBytes) {
    extracted = { status: "too_large", text: "", extractor: null };
  } else {
    const bytes = await getStorageAdapter().get(row.storageKey);
    extracted = bytes ? await extractFileText(row.filename, row.mimeType, bytes) : { status: "failed", text: "", extractor: null, error: "file bytes not found in storage" };
  }
  return writeIndex({ workspaceId, source: "file", fileId }, extracted, opts);
}

/** Index one Office doc's text (idempotent). */
export async function indexUniverDocText(workspaceId: string, docId: string, opts: IndexOptions = {}): Promise<IndexResult> {
  const doc = await withWorkspaceScope(workspaceId, (tx) =>
    tx.univerDoc.findFirst({ where: { id: docId, workspaceId }, select: { id: true, kind: true, snapshot: true } }),
  );
  if (!doc) return { status: "missing", chunks: 0, embedded: 0 };
  return writeIndex({ workspaceId, source: "doc", univerDocId: docId }, await extractUniverText(doc.kind, doc.snapshot), opts);
}

/**
 * Run indexing after the current request without making it wait. In a Next
 * request this uses after() (the platform keeps the work alive past the
 * response); elsewhere (scripts, workers, tests) it runs detached. Failures
 * are logged; the backfill script repairs anything missed.
 */
export function scheduleTextIndex(job: () => Promise<unknown>, label: string): void {
  const run = () =>
    job().catch((err) => log.warn("search text index failed", { label, error: err instanceof Error ? err.message : String(err) }));
  void (async () => {
    try {
      const { after } = await import("next/server");
      after(run);
    } catch {
      void run();
    }
  })();
}

// On write, the text is indexed at once (full text works immediately). The
// chunks are embedded right away only when this process already has the
// model loaded (any Spotlight search loads it); otherwise the search-index
// cron (/api/cron/search-index) embeds them, so an upload never pays for a
// model load. SPOTLIGHT_INDEX_ON_WRITE=off turns the write hook off (the
// cron and the backfill script still index).
export function scheduleFileTextIndex(workspaceId: string, fileId: string): void {
  if (process.env.SPOTLIGHT_INDEX_ON_WRITE === "off") return;
  scheduleTextIndex(() => indexFileText(workspaceId, fileId, { embed: spotlightEmbedderLoaded() }), `file:${fileId}`);
}

export function scheduleUniverDocTextIndex(workspaceId: string, docId: string): void {
  if (process.env.SPOTLIGHT_INDEX_ON_WRITE === "off") return;
  scheduleTextIndex(() => indexUniverDocText(workspaceId, docId, { embed: spotlightEmbedderLoaded() }), `doc:${docId}`);
}

export interface BackfillSummary {
  files: { scanned: number; indexed: number; unchanged: number; skipped: number; failed: number };
  docs: { scanned: number; indexed: number; unchanged: number; skipped: number; failed: number };
}

/**
 * Index every live file and Office doc that has no text row yet, or whose
 * text is out of date (force). Idempotent: running it twice changes nothing.
 */
export async function backfillTextIndex(opts: { workspaceId?: string; force?: boolean; embed?: boolean; embedder?: Embed; limit?: number } = {}): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    files: { scanned: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0 },
    docs: { scanned: 0, indexed: 0, unchanged: 0, skipped: 0, failed: 0 },
  };
  const limit = opts.limit ?? 10_000;
  const tally = (bucket: BackfillSummary["files"], r: IndexResult) => {
    bucket.scanned++;
    if (r.status === "unchanged") bucket.unchanged++;
    else if (r.status === "indexed" || r.status === "empty") bucket.indexed++;
    else if (r.status === "failed") bucket.failed++;
    else bucket.skipped++;
  };
  const files = await prisma.workspaceFile.findMany({
    where: { trashedAt: null, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
    select: { id: true, workspaceId: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const f of files) tally(summary.files, await indexFileText(f.workspaceId, f.id, opts));
  const workspaces = opts.workspaceId
    ? [opts.workspaceId]
    : (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id);
  for (const ws of workspaces) {
    const docs = await withWorkspaceScope(ws, (tx) => tx.univerDoc.findMany({ where: { workspaceId: ws }, select: { id: true }, take: limit }));
    for (const d of docs) tally(summary.docs, await indexUniverDocText(ws, d.id, opts));
  }
  return summary;
}

/** The stored text of a record, for agents ("ask about this"). Null when not indexed. */
export async function storedText(workspaceId: string, key: { fileId?: string; univerDocId?: string }, maxChars = 6_000): Promise<{ status: string; text: string | null; truncated: boolean } | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.searchText.findFirst({
      where: { workspaceId, ...(key.fileId ? { fileId: key.fileId } : { univerDocId: key.univerDocId }) },
      select: { status: true, content: true, truncated: true },
    }),
  );
  if (!row) return null;
  const text = row.content ? row.content.slice(0, maxChars) : null;
  return { status: row.status, text, truncated: row.truncated || (row.content?.length ?? 0) > maxChars };
}

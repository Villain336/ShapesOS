// Marketr — Dataset Builder slice 1: ingest pipelines.
// Four source kinds — upload (PDF/DOCX/CSV/MD), Google Drive (via the
// Nango Cloud adapter), website crawl, copy-paste. Every pipeline follows
// the same shape: create Source → extract text → create Document → chunk
// with the document pointer stamped on every chunk → mark Document ready.
// A Document only flips to "ready" after all its chunks are written, so a
// crash mid-ingest leaves it "pending" (or "failed"), never half-claimed.

import { chunkInputsForDocument } from "./chunking";
import { extractTextFromUpload } from "./extract";
import type { NangoDriveAdapter } from "./nango";
import {
  DEFAULT_CHUNKING_CONFIG,
  DatasetBuilderError,
  type ChunkingConfig,
  type CrawlInput,
  type DatasetBuilderStore,
  type DatasetDocumentRecord,
  type DatasetSourceRecord,
  type PasteInput,
} from "./types";

export interface IngestResult {
  source: DatasetSourceRecord;
  document: DatasetDocumentRecord;
  chunkCount: number;
  charCount: number;
}

async function finalizeDocument(
  store: DatasetBuilderStore,
  doc: DatasetDocumentRecord,
  text: string,
  chunking: ChunkingConfig,
): Promise<IngestResult> {
  const inputs = chunkInputsForDocument(
    doc.workspaceId,
    doc.id,
    text,
    chunking,
  );
  for (const input of inputs) {
    await store.createChunk(input);
  }
  const ready = await store.updateDocument(doc.id, {
    charCount: text.length,
    status: "ready",
  });
  const source = await store.getSource(doc.sourceId);
  if (!source) {
    // Unreachable when the store enforces the FK, but fail loud anyway.
    throw new DatasetBuilderError(
      "UNKNOWN_SOURCE",
      `document "${doc.id}" lost its source mid-ingest`,
    );
  }
  return { source, document: ready, chunkCount: inputs.length, charCount: text.length };
}

async function failDocument(
  store: DatasetBuilderStore,
  doc: DatasetDocumentRecord,
  err: unknown,
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  await store.updateDocument(doc.id, { status: "failed", error: message });
  if (err instanceof DatasetBuilderError) throw err;
  throw new DatasetBuilderError("EXTRACTION_FAILED", message);
}

// --------------------------------------------------------------- upload ---

export interface UploadIngestInput {
  workspaceId: string;
  filename: string;
  bytes: Uint8Array;
  /** Display name for the source; defaults to the filename. */
  label?: string;
  chunking?: ChunkingConfig;
}

export async function ingestUpload(
  store: DatasetBuilderStore,
  input: UploadIngestInput,
): Promise<IngestResult> {
  const chunking = input.chunking ?? DEFAULT_CHUNKING_CONFIG;
  const source = await store.createSource({
    workspaceId: input.workspaceId,
    kind: "upload",
    name: input.label ?? input.filename,
    externalRef: input.filename,
  });
  const doc = await store.createDocument({
    workspaceId: input.workspaceId,
    sourceId: source.id,
    name: input.filename,
    byteSize: input.bytes.length,
  });
  try {
    const extracted = extractTextFromUpload(input.filename, input.bytes);
    await store.updateDocument(doc.id, { mimeType: extracted.mimeType });
    return await finalizeDocument(store, doc, extracted.text, chunking);
  } catch (err) {
    return failDocument(store, doc, err);
  }
}

// ---------------------------------------------------------------- drive ---

export interface DriveIngestInput {
  workspaceId: string;
  /** Nango connection id for the tenant's Google Drive. */
  connectionId: string;
  fileId: string;
  adapter: NangoDriveAdapter;
  chunking?: ChunkingConfig;
}

export async function ingestDriveFile(
  store: DatasetBuilderStore,
  input: DriveIngestInput,
): Promise<IngestResult> {
  const chunking = input.chunking ?? DEFAULT_CHUNKING_CONFIG;
  const content = await input.adapter.downloadFile(input.fileId);
  const source = await store.createSource({
    workspaceId: input.workspaceId,
    kind: "drive",
    name: content.ref.name,
    externalRef: content.ref.id,
    config: { connectionId: input.connectionId, mimeType: content.ref.mimeType },
  });
  const doc = await store.createDocument({
    workspaceId: input.workspaceId,
    sourceId: source.id,
    name: content.filename,
    byteSize: content.bytes.length,
  });
  try {
    const extracted = extractTextFromUpload(content.filename, content.bytes);
    await store.updateDocument(doc.id, { mimeType: extracted.mimeType });
    return await finalizeDocument(store, doc, extracted.text, chunking);
  } catch (err) {
    return failDocument(store, doc, err);
  }
}

// ------------------------------------------------------------------ web ---

const MAX_CRAWL_BYTES = 2_000_000;

export async function ingestWeb(
  store: DatasetBuilderStore,
  input: CrawlInput,
): Promise<IngestResult> {
  const chunking = input.chunking ?? DEFAULT_CHUNKING_CONFIG;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new DatasetBuilderError("VALIDATION_FAILED", `"${input.url}" is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DatasetBuilderError(
      "VALIDATION_FAILED",
      `refusing to crawl non-http(s) URL: "${input.url}"`,
    );
  }
  const source = await store.createSource({
    workspaceId: input.workspaceId,
    kind: "web",
    name: input.label ?? url.hostname + url.pathname,
    externalRef: url.toString(),
  });
  const doc = await store.createDocument({
    workspaceId: input.workspaceId,
    sourceId: source.id,
    name: url.toString(),
    mimeType: "text/html",
  });
  try {
    const text = await fetchAndExtractMainContent(url.toString());
    return await finalizeDocument(store, doc, text, chunking);
  } catch (err) {
    return failDocument(store, doc, err);
  }
}

/** Fetch a page and extract its main readable text. Injectable for tests. */
export async function fetchAndExtractMainContent(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "user-agent": "Marketr-DatasetBuilder/1.0 (+ingest)" },
      redirect: "follow",
    });
  } catch (err) {
    throw new DatasetBuilderError(
      "FETCH_FAILED",
      `could not fetch "${url}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new DatasetBuilderError(
      "FETCH_FAILED",
      `fetching "${url}" returned HTTP ${res.status}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml/.test(contentType) && contentType !== "") {
    throw new DatasetBuilderError(
      "FETCH_FAILED",
      `refusing to crawl non-HTML content type "${contentType}"`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_CRAWL_BYTES) {
    throw new DatasetBuilderError(
      "FETCH_FAILED",
      `page exceeds the ${MAX_CRAWL_BYTES}-byte crawl limit`,
    );
  }
  const text = extractMainText(buf.toString("utf8"));
  if (!text.trim()) {
    throw new DatasetBuilderError(
      "EXTRACTION_FAILED",
      `no readable text found at "${url}"`,
    );
  }
  return text;
}

/**
 * Heuristic main-content extraction: strip scripts/styles/nav/footer,
 * prefer <article>/<main>, fall back to body text with collapsed whitespace.
 */
export function extractMainText(html: string): string {
  let doc = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const article = doc.match(/<(article|main)[\s>][\s\S]*?<\/\1>/i);
  if (article) doc = article[0];
  const text = doc
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n\n");
  return text.trim();
}

// ----------------------------------------------------------------- paste ---

export async function ingestPaste(
  store: DatasetBuilderStore,
  input: PasteInput,
): Promise<IngestResult> {
  const chunking = input.chunking ?? DEFAULT_CHUNKING_CONFIG;
  const label = input.label.trim();
  if (!label) {
    throw new DatasetBuilderError(
      "VALIDATION_FAILED",
      "pasted text needs an explicit source label",
    );
  }
  const text = input.text.trim();
  if (!text) {
    throw new DatasetBuilderError("VALIDATION_FAILED", "pasted text is empty");
  }
  const source = await store.createSource({
    workspaceId: input.workspaceId,
    kind: "paste",
    name: label,
  });
  const doc = await store.createDocument({
    workspaceId: input.workspaceId,
    sourceId: source.id,
    name: label,
    mimeType: "text/plain",
    byteSize: Buffer.byteLength(text, "utf8"),
  });
  try {
    return await finalizeDocument(store, doc, text, chunking);
  } catch (err) {
    return failDocument(store, doc, err);
  }
}

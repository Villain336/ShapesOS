// Marketr — Dataset Builder slice 1: chunking.
// Splits extracted document text into overlapping character windows.
// Every chunk the pipeline emits is stamped with its document pointer
// plus position metadata (position, charStart, charEnd) — the code side
// of the zero-orphaned-chunks invariant.

import {
  DEFAULT_CHUNKING_CONFIG,
  DatasetBuilderError,
  type ChunkInput,
  type ChunkingConfig,
} from "./types";

export { DEFAULT_CHUNKING_CONFIG, validateChunkingConfig } from "./types";

export interface TextChunk {
  position: number;
  charStart: number;
  charEnd: number;
  text: string;
}

/**
 * Split text into chunks of at most `chunkSize` characters with
 * `chunkOverlap` characters of overlap between consecutive chunks.
 * Splits prefer paragraph boundaries, then sentence boundaries, then
 * whitespace, then hard cuts — boundaries are recorded in charStart/
 * charEnd so each chunk's position in the source document is recoverable.
 */
export function chunkText(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
): TextChunk[] {
  if (typeof text !== "string") {
    throw new DatasetBuilderError("VALIDATION_FAILED", "text must be a string");
  }
  const { chunkSize, chunkOverlap } = config;
  const chunks: TextChunk[] = [];
  let start = 0;
  let position = 0;
  const len = text.length;

  while (start < len) {
    let end = Math.min(start + chunkSize, len);
    if (end < len) {
      const window = text.slice(start, end);
      // Prefer paragraph, then sentence, then word boundary.
      const para = window.lastIndexOf("\n\n");
      const sent = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
        window.lastIndexOf("\n"),
      );
      const word = window.lastIndexOf(" ");
      let cut = -1;
      if (para > chunkSize * 0.4) cut = para;
      else if (sent > chunkSize * 0.4) cut = sent + 1;
      else if (word > chunkSize * 0.4) cut = word;
      if (cut > 0) end = start + cut;
    }
    const raw = text.slice(start, end).trim();
    if (raw.length > 0) {
      chunks.push({
        position: position++,
        charStart: start,
        charEnd: end,
        text: raw,
      });
    }
    if (end >= len) break;
    // Advance, keeping the overlap. Guard against zero/negative advance.
    start = Math.max(end - chunkOverlap, start + 1);
  }
  return chunks;
}

/**
 * Build store-ready chunk inputs: every input carries the non-nullable
 * documentId pointer. There is no path that creates a chunk without it.
 */
export function chunkInputsForDocument(
  workspaceId: string,
  documentId: string,
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG,
): ChunkInput[] {
  if (!documentId) {
    throw new DatasetBuilderError(
      "ORPHAN_CHUNK_REJECTED",
      "refusing to build chunks without a document pointer",
    );
  }
  return chunkText(text, config).map((c) => ({
    workspaceId,
    documentId,
    position: c.position,
    charStart: c.charStart,
    charEnd: c.charEnd,
    text: c.text,
  }));
}

// Marketr — Phase 10 M9: file-based versioned corpus store.
//
// DECISION (documented per task): no new DB tables — the database got no
// corpus migration by design (schema frozen). The corpus is a product asset,
// not tenant data, so it lives OUTSIDE Postgres as versioned JSONL files:
//
//   data/corpus/manifest.json          — versioned source registry (COMMITTED)
//   data/corpus/main/chunks.jsonl      — Tier 1-shippable + Tier 2 chunks
//   data/corpus/main/LICENSE.txt       — license/attribution note for the asset
//   data/corpus/by-sa/chunks.jsonl     — BY-SA chunks ONLY (separately-licensed asset)
//   data/corpus/by-sa/LICENSE.txt      — the CC-BY-SA 4.0 note alongside
//
// Embeddings are 384-d L2-normalized vectors (local MiniLM, see embed.ts),
// rounded to 4 decimals to keep the JSONL compact. corpus_version in the
// manifest increments ONLY when sources change — never on reads/evals.
// Chunk files are committed while small (< ~5MB); if the corpus grows past
// that, gitignore them and treat the manifest as the version record.

import fs from "node:fs";
import path from "node:path";
import type { CorpusChunk, CorpusManifest } from "./types";

export type CorpusAsset = "main" | "by-sa";

/** Override for tests / ops: CORPUS_DIR. */
export function corpusDir(): string {
  return process.env.CORPUS_DIR ?? path.join(process.cwd(), "data", "corpus");
}

export function assetDir(asset: CorpusAsset): string {
  return path.join(corpusDir(), asset);
}

function chunksPath(asset: CorpusAsset): string {
  return path.join(assetDir(asset), "chunks.jsonl");
}

function manifestPath(): string {
  return path.join(corpusDir(), "manifest.json");
}

/** Read the manifest; returns null when the corpus has never been ingested. */
export function loadManifest(): CorpusManifest | null {
  try {
    const raw = fs.readFileSync(manifestPath(), "utf8");
    return JSON.parse(raw) as CorpusManifest;
  } catch {
    return null;
  }
}

export function saveManifest(m: CorpusManifest): void {
  fs.mkdirSync(corpusDir(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2) + "\n", "utf8");
}

function serializeChunk(c: CorpusChunk): string {
  const emb = c.embedding ? c.embedding.map((v) => Math.round(v * 10000) / 10000) : null;
  return JSON.stringify({ ...c, embedding: emb });
}

function parseChunk(line: string): CorpusChunk {
  return JSON.parse(line) as CorpusChunk;
}

/** Append chunks to an asset file. BY-SA material may ONLY be appended to
 *  the "by-sa" asset — enforced here as well as at the ingest gate. */
export function appendChunks(asset: CorpusAsset, chunks: CorpusChunk[]): void {
  for (const c of chunks) {
    const isBySa = c.provenance.license === "CC-BY-SA-4.0";
    if (asset === "main" && isBySa) {
      throw new Error(
        `[corpus] SEGREGATION VIOLATION: refusing to write BY-SA chunk ${c.id} to the main asset.`,
      );
    }
    if (asset === "by-sa" && !isBySa) {
      throw new Error(
        `[corpus] refusing to write non-BY-SA chunk ${c.id} to the segregated BY-SA asset.`,
      );
    }
    if (!c.provenance.license) {
      throw new Error(`[corpus] refusing to store chunk ${c.id} without license metadata.`);
    }
  }
  fs.mkdirSync(assetDir(asset), { recursive: true });
  const payload = chunks.map(serializeChunk).join("\n") + "\n";
  fs.appendFileSync(chunksPath(asset), payload, "utf8");
}

/** Load all chunks from an asset (streamed parse; null embeddings dropped
 *  to empty arrays — retrieval skips null-embedding chunks). */
export function loadChunks(asset: CorpusAsset): CorpusChunk[] {
  const p = chunksPath(asset);
  if (!fs.existsSync(p)) return [];
  const out: CorpusChunk[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(parseChunk(t));
  }
  return out;
}

/** Remove an asset's chunks (used by re-ingest, never in production code). */
export function clearAsset(asset: CorpusAsset): void {
  const p = chunksPath(asset);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Chunk counts per asset, read from disk. */
export function assetCounts(): Record<CorpusAsset, number> {
  return { main: loadChunks("main").length, "by-sa": loadChunks("by-sa").length };
}

const MAIN_LICENSE_NOTE = `ShapesOS expert-corpus — main asset
========================================
This data asset contains marketing-expertise text chunks ingested under the
clean-sourcing tiers of SPEC-PHASE10.md §M9:

  • Google Search Central documentation — © Google, licensed CC-BY 4.0
    (https://creativecommons.org/licenses/by/4.0/). Attribution: Google.
  • Public-domain works (Claude Hopkins, Walter Dill Scott, U.S. SBA, U.S. FTC)
    — no restrictions.
  • CC-BY 4.0 / CC-BY 3.0 textbook material — attributed per chunk (license
    URL carried in chunk provenance).
  • CC0-1.0 and MIT-licensed GitHub material — attributed per chunk.

Every chunk carries its own {source_title, author, license, license_url,
retrieved_date} provenance. This note is the asset-level summary; chunk
provenance is authoritative.
`;

const BY_SA_LICENSE_NOTE = `ShapesOS expert-corpus — BY-SA segregated asset
================================================
This data asset is SEPARATELY LICENSED from the main corpus asset and from
the ShapesOS (AGPL) codebase.

Contents: Wikipedia article text (marketing clusters), © Wikimedia
contributors, licensed under Creative Commons Attribution-ShareAlike 4.0
International (https://creativecommons.org/licenses/by-sa/4.0/).

Share-alike notice: this asset's contents are CC-BY-SA 4.0. They are kept
physically separate (this directory) with chunk-level provenance so the
share-alike scope is bounded to this asset. Do not copy these chunks into
the main asset.
`;

/** Write the asset-level LICENSE notes (idempotent). */
export function writeLicenseNotes(): void {
  for (const [asset, note] of [
    ["main", MAIN_LICENSE_NOTE],
    ["by-sa", BY_SA_LICENSE_NOTE],
  ] as const) {
    fs.mkdirSync(assetDir(asset), { recursive: true });
    fs.writeFileSync(path.join(assetDir(asset), "LICENSE.txt"), note, "utf8");
  }
}

#!/usr/bin/env tsx
// Marketr — Phase 10 M7a: Google Search Central corpus v3 re-ingest.
//
// Data-quality fix: corpus v2 fetched GSC docs without hl=en, so Google served
// the ko locale for some pages (~33 chunks with Hangul, several ~70% Korean)
// and the generic <nav> stripping missed devsite's <devsite-*> custom elements
// (google-search-central#0 was pure nav boilerplate). This script:
//   1. Backs up data/corpus/main/chunks.jsonl + manifest.json to /tmp.
//   2. Removes the 91 stale google-search-central chunks from the main asset.
//   3. Re-ingests the 4 GSC URLs via ingestSeedSource (which now sends
//      hl=en + Accept-Language: en and extracts <article class="devsite-article">,
//      dropping all devsite chrome).
//   4. Bumps the manifest to v3 and refreshes the gsc source record.
// Then run: npx tsx scripts/eval-corpus.mts (precision must hold ≥ 0.60).
//
// Usage: npx tsx scripts/reingest-gsc-v3.mts

import fs from "node:fs";
import path from "node:path";
import { SEED_SOURCES } from "../lib/intelligence/corpus/allowlist";
import { ingestSeedSource } from "../lib/intelligence/corpus/ingest";
import { assetDir, loadManifest, saveManifest, corpusDir } from "../lib/intelligence/corpus/store";
import type { CorpusChunk, CorpusManifest } from "../lib/intelligence/corpus/types";

const TODAY = new Date().toISOString().slice(0, 10);
const SOURCE_ID = "google-search-central";
const HANGUL = /[\uac00-\ud7af]/;

function chunkFilePath(): string {
  return path.join(assetDir("main"), "chunks.jsonl");
}

function readAllChunks(p: string): CorpusChunk[] {
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as CorpusChunk);
}

function writeAllChunks(p: string, chunks: CorpusChunk[]): void {
  const payload = chunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  fs.writeFileSync(p, payload, "utf8");
}

async function main(): Promise<void> {
  const p = chunkFilePath();
  const manifestP = path.join(corpusDir(), "manifest.json");

  // 1. Backups (never mutate without a rollback copy).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bakChunks = `/tmp/corpus-v2-backup/chunks.jsonl.${stamp}`;
  const bakManifest = `/tmp/corpus-v2-backup/manifest.json.${stamp}`;
  fs.mkdirSync("/tmp/corpus-v2-backup", { recursive: true });
  fs.copyFileSync(p, bakChunks);
  fs.copyFileSync(manifestP, bakManifest);
  console.log(`[gsc-v3] backups → ${bakChunks}, ${bakManifest}`);

  // 2. Drop stale GSC chunks.
  const all = readAllChunks(p);
  const stale = all.filter((c) => c.provenance?.sourceId === SOURCE_ID);
  const kept = all.filter((c) => c.provenance?.sourceId !== SOURCE_ID);
  console.log(`[gsc-v3] dropping ${stale.length} stale ${SOURCE_ID} chunks (${all.length} → ${kept.length})`);
  writeAllChunks(p, kept);

  // 3. Re-ingest (fetchText now forces hl=en; htmlToText extracts the article).
  const def = SEED_SOURCES.find((d) => d.id === SOURCE_ID);
  if (!def) throw new Error(`[gsc-v3] FATAL: ${SOURCE_ID} not in SEED_SOURCES`);
  const { record, chunks } = await ingestSeedSource(def, TODAY);
  if (record.status !== "active") {
    // Roll back: stale chunks are better than none (manifest untouched).
    fs.copyFileSync(bakChunks, p);
    throw new Error(`[gsc-v3] FATAL: re-ingest failed (${record.pendingReason}); rolled back chunks.jsonl`);
  }
  const hangulChunks = chunks.filter((c) => HANGUL.test(c.text)).length;
  console.log(
    `[gsc-v3] re-ingested: ${chunks.length} chunks across ${def.fetchUrls.length} URLs; ` +
      `chunks still containing Hangul: ${hangulChunks}`,
  );
  if (hangulChunks > 0) {
    throw new Error(`[gsc-v3] FATAL: ${hangulChunks} fresh chunks contain Hangul — locale fix did not hold.`);
  }

  // 4. Manifest v3.
  const prev = loadManifest();
  if (!prev) throw new Error("[gsc-v3] FATAL: no manifest to bump");
  const nextVersion = prev.corpusVersion + 1;
  record.version = nextVersion;
  const sources = prev.sources.map((s) => (s.id === SOURCE_ID ? record : s));
  const manifest: CorpusManifest = {
    corpusVersion: nextVersion,
    updatedAt: new Date().toISOString(),
    assets: { main: kept.length + chunks.length, "by-sa": prev.assets["by-sa"] },
    sources,
    evalPrecision: prev.evalPrecision,
    evalRunAt: prev.evalRunAt,
  };
  saveManifest(manifest);
  console.log(
    `[gsc-v3] manifest v${nextVersion}: ${manifest.assets.main} main chunks; ` +
      `eval precision carried over (${prev.evalPrecision}) — re-run scripts/eval-corpus.mts`,
  );
}

main().catch((err) => {
  console.error("[gsc-v3] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});

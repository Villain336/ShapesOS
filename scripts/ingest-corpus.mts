#!/usr/bin/env tsx
// Marketr — Phase 10 M9: corpus ingest runner.
//
// Ingests the full 24-source registry (M9-CORPUS-SOURCES.md #1–24) in
// priority order: verbatim-ingestible sources (Tier 1 CC-BY-4.0 + Tier 2)
// via ingestSeedSource(), learn-only sources (#2–8, #21–24) via their
// Tier 1S original-synthesis playbooks (ingestSynthesisPlaybook()).
//
// Sources whose fetch fails or whose license/URL is uncertain are recorded
// PENDING with a reason — never ingested. The learn-only verbatim gate is
// enforced by assertIngestAllowed(); the 1S gate by assertSynthesisAllowed().
//
// Fresh-ingest semantics: clears both assets first, then ingests, then
// writes the manifest with corpus_version = previous + 1 (1 on first run).
//
// Usage:
//   npx tsx scripts/ingest-corpus.mts [--dry-run]
//   CORPUS_DIR=/tmp/corpus-test npx tsx scripts/ingest-corpus.mts

import {
  SEED_SOURCES,
  SYNTHESIS_PLAYBOOKS,
  seedSourceById,
} from "../lib/intelligence/corpus/allowlist";
import {
  ingestSeedSource,
  ingestSynthesisPlaybook,
  pendingRecord,
  ensureLicenseNotes,
} from "../lib/intelligence/corpus/ingest";
import {
  loadManifest,
  saveManifest,
  clearAsset,
  assetCounts,
} from "../lib/intelligence/corpus/store";
import type { CorpusManifest, CorpusSourceRecord } from "../lib/intelligence/corpus/types";

const dryRun = process.argv.includes("--dry-run");
const TODAY = new Date().toISOString().slice(0, 10);

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  console.log(`[m9-ingest] ${dryRun ? "DRY RUN — " : ""}ingesting 24-source registry (${TODAY})`);
  const prev = loadManifest();
  const nextVersion = (prev?.corpusVersion ?? 0) + 1;

  const records: CorpusSourceRecord[] = [];
  let verbatim = 0;
  let synthesized = 0;
  let pending = 0;

  if (!dryRun) {
    clearAsset("main");
    clearAsset("by-sa");
    ensureLicenseNotes();
  }

  for (const def of SEED_SOURCES) {
    if (def.tier === "learn-only") {
      // Learn-only → Tier 1S synthesis playbook only. Never verbatim.
      const pb = def.playbook ?? SYNTHESIS_PLAYBOOKS.find((p) => p.sourceId === def.id);
      if (!pb) {
        records.push(pendingRecord(def, TODAY, def.pendingReason ?? "No Tier 1S playbook defined yet."));
        pending++;
        console.log(`  … ${pad(def.id, 38)} pending (no 1S playbook yet)`);
        continue;
      }
      if (dryRun) {
        records.push({
          id: def.id, title: def.title, author: def.author, tier: "learn-only",
          license: "learn-only", licenseUrl: "", sourceUrl: "", status: "active",
          mode: "synthesis-1s", chunks: 0, version: nextVersion, retrievedDate: TODAY,
          segregatedAsset: false,
        });
        synthesized++;
        console.log(`  ~ ${pad(def.id, 38)} 1S playbook (dry run): ${pb.file}`);
        continue;
      }
      const { record } = await ingestSynthesisPlaybook(
        {
          sourceId: def.id,
          title: def.title,
          targetTitle: def.title,
          author: "Marketr (original synthesis)",
          file: pb.file,
          synthesizedFrom: pb.synthesizedFrom,
        },
        TODAY,
        { registry: SEED_SOURCES },
      );
      record.version = nextVersion;
      records.push(record);
      if (record.status === "active") {
        synthesized++;
        console.log(`  ✓ ${pad(def.id, 38)} 1S: ${record.chunks} chunks (${pb.file})`);
      } else {
        pending++;
        console.log(`  … ${pad(def.id, 38)} pending: ${record.pendingReason}`);
      }
      continue;
    }

    // Verbatim-ingestible (Tier 1 shippable + Tier 2).
    if (def.fetchUrls.length === 0) {
      records.push(pendingRecord(def, TODAY));
      pending++;
      console.log(`  … ${pad(def.id, 38)} pending: ${def.pendingReason?.slice(0, 90)}`);
      continue;
    }
    if (dryRun) {
      records.push({
        id: def.id, title: def.title, author: def.author, tier: def.tier,
        license: def.license, licenseUrl: def.licenseUrl, sourceUrl: def.fetchUrls[0] ?? "",
        status: "active", mode: "verbatim", chunks: 0, version: nextVersion,
        retrievedDate: TODAY, segregatedAsset: def.license === "CC-BY-SA-4.0",
      });
      verbatim++;
      console.log(`  = ${pad(def.id, 38)} verbatim (dry run): ${def.fetchUrls.length} URL(s)`);
      continue;
    }
    const { record } = await ingestSeedSource(def, TODAY);
    record.version = nextVersion;
    records.push(record);
    if (record.status === "active") {
      verbatim++;
      console.log(`  ✓ ${pad(def.id, 38)} verbatim: ${record.chunks} chunks${record.segregatedAsset ? " [by-sa]" : ""}`);
    } else {
      pending++;
      console.log(`  … ${pad(def.id, 38)} pending: ${record.pendingReason?.slice(0, 120)}`);
    }
  }

  if (dryRun) {
    console.log(`\n[dry-run] would ingest: ${verbatim} verbatim, ${synthesized} 1S, ${pending} pending. No writes.`);
    return;
  }

  const counts = assetCounts();
  const manifest: CorpusManifest = {
    corpusVersion: nextVersion,
    updatedAt: new Date().toISOString(),
    assets: { main: counts.main, "by-sa": counts["by-sa"] },
    sources: records,
    evalPrecision: prev?.evalPrecision ?? null,
    evalRunAt: prev?.evalRunAt ?? null,
  };
  saveManifest(manifest);

  console.log(`\n[m9-ingest] corpus v${nextVersion}: ${counts.main} main chunks, ${counts["by-sa"]} by-sa chunks`);
  console.log(`[m9-ingest] sources: ${verbatim} verbatim · ${synthesized} synthesized-1S · ${pending} pending`);
  console.log(`[m9-ingest] manifest: data/corpus/manifest.json`);
}

main().catch((err) => {
  console.error("[m9-ingest] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});

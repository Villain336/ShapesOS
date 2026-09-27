#!/usr/bin/env tsx
// Marketr — v9 ingest: the 281-source Tier 1S synthesis wave (Tico, 2026-09-27).
//
// APPEND-ONLY: does NOT clear assets (unlike scripts/ingest-corpus.mts).
// For each of the 259 learn-only catalog sources with a new 1S playbook in
// data/corpus/synthesis/, runs ingestSynthesisPlaybook() (which enforces
// assertSynthesisAllowed: registry learn-only entry + file exists + >=2000
// chars) and flips the manifest record to active with real chunk counts.
//
// The 22 TOOL / TERMS-GATED pipeline items (foundation corpora, datasets,
// tools) are NOT teachable texts: they keep status "pending" with an
// enriched acquisition note — no chunks, no pseudo-synthesis.
//
// Manifest corpusVersion 8 -> 9. On any per-source failure the record stays
// pending with the failure reason — never partially ingested.
//
// Usage:
//   npx tsx scripts/ingest-1s-v9.mts [--dry-run]

import * as fs from "node:fs";
import * as path from "node:path";
import {
  SEED_SOURCES,
  SYNTHESIS_PLAYBOOKS,
} from "../lib/intelligence/corpus/allowlist";
import { ingestSynthesisPlaybook } from "../lib/intelligence/corpus/ingest";
import { loadManifest, saveManifest } from "../lib/intelligence/corpus/store";
import type { CorpusManifest } from "../lib/intelligence/corpus/types";

const dryRun = process.argv.includes("--dry-run");
const TODAY = "2026-09-27";
const META_PATH = "data/corpus/backups/wave-9/registry-meta.json";

interface RegMeta {
  name: string;
  license_class: string;
  license_basis: string;
  pillar: "marketing" | "growth" | "design";
  priority: string;
  domain_category: string;
  access_url: string;
  acquisition_only?: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

/** Honest depth label read from the playbook's own provenance header. */
function readSynthesisDepth(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8");
  const m = raw.match(/synthesis-depth:\s*([a-z-]+)/i);
  return m ? m[1]!.toLowerCase() : "parametric";
}

function acquisitionNote(meta: RegMeta): string {
  return (
    `[acquisition-note ${TODAY}] Pipeline item, not a teachable text — no 1S synthesis written, ` +
    `no chunks ingested. What it is: ${meta.domain_category}. ` +
    `Planned use in the training plan: ${meta.access_url ? `acquire via ${meta.access_url}; ` : ""}` +
    `stage-gated corpus/tool for pretraining or pipeline use. ` +
    `License gate: ${meta.license_basis} [${meta.license_class}] — acquisition only after ` +
    `license review clears; TERMS-GATED/TOOL items never enter via synthesis.`
  );
}

async function main(): Promise<void> {
  const meta: Record<string, RegMeta> = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  const prev = loadManifest();
  if (!prev) throw new Error("[v9-ingest] no manifest found");
  const nextVersion = prev.corpusVersion + 1;
  console.log(`[v9-ingest] ${dryRun ? "DRY RUN — " : ""}manifest v${prev.corpusVersion} -> v${nextVersion}`);

  const manifest: CorpusManifest = {
    ...prev,
    corpusVersion: nextVersion,
    updatedAt: new Date().toISOString(),
    sources: [...prev.sources],
  };
  const byId = new Map(manifest.sources.map((s) => [s.id, s]));

  let synthesized = 0;
  let pending = 0;
  let chunksAdded = 0;

  for (const [sourceId, m] of Object.entries(meta)) {
    const existing = byId.get(sourceId);
    if (!existing) {
      console.log(`  ! ${pad(sourceId, 40)} not in manifest — skipped`);
      continue;
    }
    if (m.acquisition_only) {
      existing.status = "pending";
      existing.chunks = 0;
      existing.version = nextVersion;
      existing.retrievedDate = TODAY;
      existing.pendingReason = acquisitionNote(m);
      pending++;
      console.log(`  - ${pad(sourceId, 40)} acquisition-note (pending, no chunks)`);
      continue;
    }
    const pb = SYNTHESIS_PLAYBOOKS.find((p) => p.sourceId === sourceId);
    if (!pb) {
      existing.status = "pending";
      existing.version = nextVersion;
      existing.pendingReason = `No Tier 1S playbook registered for the v9 wave (2026-09-27).`;
      pending++;
      console.log(`  … ${pad(sourceId, 40)} pending (no playbook registered)`);
      continue;
    }
    const filePath = path.resolve(process.cwd(), "data", "corpus", "synthesis", pb.file);
    const depth = fs.existsSync(filePath) ? readSynthesisDepth(filePath) : "missing";
    const nc = m.license_class === "NON-COMMERCIAL";

    if (dryRun) {
      console.log(`  ~ ${pad(sourceId, 40)} 1S playbook (dry run): ${pb.file} [depth=${depth}${nc ? ", NC" : ""}]`);
      continue;
    }
    const { record } = await ingestSynthesisPlaybook(
      {
        sourceId,
        title: existing.title,
        targetTitle: existing.title,
        author: "Marketr (original synthesis)",
        file: pb.file,
        synthesizedFrom: [m.name],
      },
      TODAY,
      {
        registry: SEED_SOURCES,
        provenanceExtra: {
          synthesisDepth: depth,
          ...(nc ? { ncFlaggedSource: true as const } : {}),
        },
      },
    );
    record.version = nextVersion;
    // Preserve catalog provenance on the manifest record.
    const idx = manifest.sources.findIndex((s) => s.id === sourceId);
    manifest.sources[idx] = record;
    byId.set(sourceId, record);
    if (record.status === "active") {
      synthesized++;
      chunksAdded += record.chunks;
      console.log(`  ✓ ${pad(sourceId, 40)} 1S: ${record.chunks} chunks (${pb.file}) [depth=${depth}${nc ? ", NC" : ""}]`);
    } else {
      pending++;
      console.log(`  … ${pad(sourceId, 40)} pending: ${record.pendingReason}`);
    }
  }

  if (!dryRun) {
    saveManifest(manifest);
    console.log(`[v9-ingest] manifest saved: v${nextVersion}, ${synthesized} synthesized (${chunksAdded} chunks), ${pending} pending`);
  } else {
    console.log(`[v9-ingest] dry run complete: ${Object.keys(meta).length} records examined`);
  }
}

main().catch((err) => {
  console.error("[v9-ingest] FATAL:", err);
  process.exit(1);
});

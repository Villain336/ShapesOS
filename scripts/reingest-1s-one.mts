import * as fs from "node:fs";
import { SEED_SOURCES } from "../lib/intelligence/corpus/allowlist";
import { ingestSynthesisPlaybook } from "../lib/intelligence/corpus/ingest";
import { loadManifest, saveManifest } from "../lib/intelligence/corpus/store";

const sourceId = "v8-google-career-certificates-coursera";
const SID = `1s-${sourceId}`;

// 1. Remove stale chunks for this source from the main asset.
const chunksPath = "data/corpus/main/chunks.jsonl";
const lines = fs.readFileSync(chunksPath, "utf8").split("\n");
const kept: string[] = [];
let removed = 0;
for (const ln of lines) {
  if (!ln.trim()) continue;
  try {
    const c = JSON.parse(ln);
    if (c?.provenance?.sourceId === SID) { removed++; continue; }
  } catch { /* keep unparseable lines */ }
  kept.push(ln);
}
fs.writeFileSync(chunksPath, kept.join("\n") + "\n");
console.log(`removed ${removed} stale chunks for ${SID}`);

// 2. Re-ingest the single playbook.
const meta = JSON.parse(fs.readFileSync("data/corpus/backups/wave-9/registry-meta.json", "utf8"))[sourceId];
const raw = fs.readFileSync(`data/corpus/synthesis/${sourceId}-playbook.md`, "utf8");
const depth = /synthesis-depth:\s*([a-z-]+)/i.exec(raw)?.[1]?.toLowerCase() ?? "parametric";
const { record } = await ingestSynthesisPlaybook(
  { sourceId, title: meta.name, targetTitle: meta.name, author: "Marketr (original synthesis)",
    file: `${sourceId}-playbook.md`, synthesizedFrom: [meta.name] },
  "2026-09-27",
  { registry: SEED_SOURCES, provenanceExtra: { synthesisDepth: depth } },
);
console.log(`re-ingested: status=${record.status} chunks=${record.chunks}`);
if (record.status !== "active") { console.error("FAILED:", record.pendingReason); process.exit(1); }

// 3. Update the manifest record's chunk count.
const manifest = loadManifest()!;
const idx = manifest.sources.findIndex((s) => s.id === sourceId);
record.version = manifest.corpusVersion;
manifest.sources[idx] = record;
manifest.updatedAt = new Date().toISOString();
saveManifest(manifest);
console.log("manifest updated");

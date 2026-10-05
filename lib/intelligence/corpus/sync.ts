// ShapesOS — Deploy PR (WS=state): the knowledge corpus on a multi-instance
// install.
//
// The corpus is a PLATFORM asset (shared by every tenant) kept as files —
// manifest.json, <asset>/chunks.jsonl, LICENSE notes, eval results, proposal
// and removal-flag JSON — and read with synchronous fs calls throughout
// lib/intelligence/corpus. On a single box (MARKETR_STORAGE=local) that
// directory is data/corpus (CORPUS_DIR) and nothing here does anything.
//
// With MARKETR_STORAGE=s3 there is no shared disk, so:
//
//   * the published snapshot lives in the shared blob store (namespace
//     "corpus", same relative layout). An operator builds it with the ingest
//     script on a machine with the repo and publishes it with
//     `npx tsx scripts/corpus-publish.mts` (publishCorpusSnapshot below);
//   * every instance keeps a READ CACHE of that snapshot in corpusDir()
//     (os.tmpdir()/shapes-corpus unless CORPUS_DIR is set) and refreshes it
//     with ensureCorpusFresh() — at most once a minute per process, and only
//     when the published manifest changed — before the corpus is read;
//   * runtime mutation of the corpus from the app (proposals, removal flags,
//     the rebuild job that spawns the ingest script) is refused
//     (corpusReadOnlyReason): those writes would land on one replica's local
//     disk only, and the runner image cannot run the ingest script anyway.
//     The same refusal applies on DEPLOYMENT_MODE=hosted (class c);
//   * retrieval counters are in Postgres on every install (activity.ts).

import { promises as fs } from "node:fs";
import path from "node:path";
import { blobDelete, blobGet, blobList, blobPut, storageMode } from "@/lib/filesystem/storage";
import { deploymentMode } from "@/lib/billing/trial";
import { corpusDir } from "./store";

/** Files of a published snapshot, relative to the corpus dir (manifest last). */
export const CORPUS_SNAPSHOT_FILES = [
  "main/chunks.jsonl",
  "main/LICENSE.txt",
  "by-sa/chunks.jsonl",
  "by-sa/LICENSE.txt",
  "eval-results.json",
  "removals.json",
] as const;
const MANIFEST = "manifest.json";
const PROPOSED_PREFIX = "proposed/";
/** How often one process checks for a newer published snapshot. */
export const CORPUS_SYNC_INTERVAL_MS = 60_000;

/** True when the corpus is distributed through the shared blob store. */
export function corpusIsShared(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return storageMode(env) === "s3";
  } catch {
    return false;
  }
}

/**
 * Why the app may not change the corpus here (null = it may). Operators
 * maintain a shared/hosted corpus with the ingest + publish scripts.
 */
export function corpusReadOnlyReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!corpusIsShared(env) && deploymentMode(env) !== "hosted") return null;
  return (
    "The knowledge corpus is read-only on this install: it runs on several instances without a shared disk. " +
    "An operator updates it from a checkout of the repo (scripts/ingest-corpus.mts, then scripts/corpus-publish.mts)."
  );
}

let lastCheck = 0;
let inflight: Promise<CorpusSyncResult> | null = null;
let warnedMissing = false;

export type CorpusSyncResult = "local" | "fresh" | "synced" | "unavailable";

/**
 * Make the local read cache match the published snapshot (shared mode only).
 * Never throws: on any failure the existing cache keeps serving.
 */
export async function ensureCorpusFresh(opts: { force?: boolean; now?: number } = {}): Promise<CorpusSyncResult> {
  if (!corpusIsShared()) return "local";
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastCheck < CORPUS_SYNC_INTERVAL_MS) return "fresh";
  if (inflight) return inflight;
  lastCheck = now;
  inflight = syncOnce()
    .catch((err) => {
      console.warn(`[corpus] snapshot refresh failed; serving the cached copy: ${err instanceof Error ? err.message : String(err)}`);
      return "unavailable" as const;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function syncOnce(): Promise<CorpusSyncResult> {
  const remote = await blobGet("corpus", MANIFEST);
  if (!remote) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[corpus] no published corpus snapshot in shared storage (run scripts/corpus-publish.mts)");
    }
    return "unavailable";
  }
  const dir = corpusDir();
  const local = await fs.readFile(path.join(dir, MANIFEST)).catch(() => null);
  if (local && local.equals(remote)) return "fresh";

  // Download into a staging directory, then swap it in.
  const staging = `${dir}.staging-${process.pid}-${Date.now().toString(36)}`;
  await fs.rm(staging, { recursive: true, force: true });
  const { objects } = await blobList("corpus", "");
  for (const o of objects) {
    if (o.path === MANIFEST) continue;
    const bytes = await blobGet("corpus", o.path);
    if (!bytes) continue;
    const target = path.join(staging, ...o.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, MANIFEST), remote);
  const old = `${dir}.old-${process.pid}-${Date.now().toString(36)}`;
  await fs.rename(dir, old).catch(() => undefined);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.rename(staging, dir);
  await fs.rm(old, { recursive: true, force: true }).catch(() => undefined);
  return "synced";
}

/** Test seam: forget the throttle. */
export function __resetCorpusSyncForTests(): void {
  lastCheck = 0;
  inflight = null;
  warnedMissing = false;
}

/**
 * Publish a corpus directory (data/corpus after an ingest) to the shared blob
 * store: every snapshot file present, the proposal JSONs (stale remote ones
 * are removed), and the manifest LAST so readers never see a manifest
 * without its chunks.
 */
export async function publishCorpusSnapshot(fromDir: string): Promise<{ uploaded: string[]; removed: string[] }> {
  if (!corpusIsShared()) throw new Error("publishCorpusSnapshot needs MARKETR_STORAGE=s3 and the MARKETR_S3_* settings.");
  const manifest = await fs.readFile(path.join(fromDir, MANIFEST)).catch(() => null);
  if (!manifest) throw new Error(`${path.join(fromDir, MANIFEST)} not found — run scripts/ingest-corpus.mts first.`);
  const uploaded: string[] = [];
  for (const rel of CORPUS_SNAPSHOT_FILES) {
    const bytes = await fs.readFile(path.join(fromDir, ...rel.split("/"))).catch(() => null);
    if (!bytes) continue;
    await blobPut("corpus", rel, bytes);
    uploaded.push(rel);
  }
  const localProposals = new Set<string>();
  for (const name of await fs.readdir(path.join(fromDir, "proposed")).catch(() => [] as string[])) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) continue;
    const rel = `${PROPOSED_PREFIX}${name}`;
    await blobPut("corpus", rel, await fs.readFile(path.join(fromDir, "proposed", name)));
    localProposals.add(rel);
    uploaded.push(rel);
  }
  const removed: string[] = [];
  for (const o of (await blobList("corpus", PROPOSED_PREFIX)).objects) {
    if (!localProposals.has(o.path)) {
      await blobDelete("corpus", o.path);
      removed.push(o.path);
    }
  }
  await blobPut("corpus", MANIFEST, manifest, "application/json");
  uploaded.push(MANIFEST);
  return { uploaded, removed };
}

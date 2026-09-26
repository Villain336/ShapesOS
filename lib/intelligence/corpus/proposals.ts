// Marketr — Knowledge Brain: proposed-source + removal-flag storage.
//
// The corpus itself is a workspace-agnostic product asset (file-based,
// schema frozen). Proposed sources and removal flags live alongside it in
// data/corpus/ as JSON — runtime data, gitignored like the corpus assets.
// Nothing here touches the ingested corpus: proposals render as "proposed"
// nodes in the brain; removal flags only take effect on the next corpus
// rebuild (the ingest script honors data/corpus/removals.json).

import fs from "node:fs";
import path from "node:path";
import { corpusDir } from "./store";
import type { ProposedSource, BrainPillar } from "./graph";

const PILLARS: BrainPillar[] = ["marketing", "growth", "design"];

function proposedDir(): string {
  return path.join(corpusDir(), "proposed");
}
function removalsPath(): string {
  return path.join(corpusDir(), "removals.json");
}
export function rebuildStatusPath(): string {
  return path.join(corpusDir(), "rebuild-status.json");
}
export function rebuildLogPath(): string {
  return path.join(corpusDir(), "rebuild.log");
}

/** Strict id hygiene: lowercase slug, letters/digits/dashes, ≤64 chars. */
export function sanitizeId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : null;
}

export function sanitizePillar(raw: unknown): BrainPillar {
  return typeof raw === "string" && (PILLARS as string[]).includes(raw)
    ? (raw as BrainPillar)
    : "marketing";
}

function ensureDir(): void {
  fs.mkdirSync(proposedDir(), { recursive: true });
}

export function listProposed(): ProposedSource[] {
  try {
    ensureDir();
    return fs
      .readdirSync(proposedDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(proposedDir(), f), "utf8")) as ProposedSource)
      .filter((p) => p && typeof p.id === "string" && p.status === "proposed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function getProposed(id: string): ProposedSource | null {
  try {
    const p = path.join(proposedDir(), `${id}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as ProposedSource;
  } catch {
    return null;
  }
}

export function saveProposed(p: ProposedSource): void {
  ensureDir();
  fs.writeFileSync(path.join(proposedDir(), `${p.id}.json`), JSON.stringify(p, null, 2));
}

export function deleteProposed(id: string): boolean {
  try {
    const p = path.join(proposedDir(), `${id}.json`);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    // Remove any uploaded payload alongside it.
    const payload = path.join(proposedDir(), `${id}.payload`);
    if (fs.existsSync(payload)) fs.unlinkSync(payload);
    return true;
  } catch {
    return false;
  }
}

/** Uploaded/pasted payload bytes for a proposal (kept out of the JSON). */
export function saveProposedPayload(id: string, buf: Buffer): void {
  ensureDir();
  fs.writeFileSync(path.join(proposedDir(), `${id}.payload`), buf);
}

export function readProposedPayload(id: string): Buffer | null {
  try {
    const p = path.join(proposedDir(), `${id}.payload`);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  } catch {
    return null;
  }
}

export type RemovalMap = Record<string, { reason: string; flaggedAt: string; flaggedBy: string }>;

export function listRemovals(): RemovalMap {
  try {
    const p = removalsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")) as RemovalMap;
  } catch {
    return {};
  }
}

export function removalIdMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, r] of Object.entries(listRemovals())) m.set(id, r.reason);
  return m;
}

export function flagRemoval(id: string, reason: string, flaggedBy: string): void {
  const all = listRemovals();
  all[id] = { reason, flaggedAt: new Date().toISOString(), flaggedBy };
  fs.writeFileSync(removalsPath(), JSON.stringify(all, null, 2));
}

export function unflagRemoval(id: string): boolean {
  const all = listRemovals();
  if (!(id in all)) return false;
  delete all[id];
  fs.writeFileSync(removalsPath(), JSON.stringify(all, null, 2));
  return true;
}

export interface RebuildStatus {
  state: "idle" | "running" | "succeeded" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  pid: number | null;
  error: string | null;
}

export function readRebuildStatus(): RebuildStatus {
  try {
    const p = rebuildStatusPath();
    if (!fs.existsSync(p)) return { state: "idle", startedAt: null, finishedAt: null, pid: null, error: null };
    return JSON.parse(fs.readFileSync(p, "utf8")) as RebuildStatus;
  } catch {
    return { state: "idle", startedAt: null, finishedAt: null, pid: null, error: null };
  }
}

export function writeRebuildStatus(s: RebuildStatus): void {
  fs.mkdirSync(corpusDir(), { recursive: true });
  fs.writeFileSync(rebuildStatusPath(), JSON.stringify(s, null, 2));
}

export function readRebuildLogTail(lines = 60): string {
  try {
    const p = rebuildLogPath();
    if (!fs.existsSync(p)) return "";
    const all = fs.readFileSync(p, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

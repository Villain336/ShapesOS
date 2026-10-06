// Marketr — Knowledge Brain: audit-center data.
//
// Real corpus events and usage counters. Everything here reads runtime
// state that already exists (proposals, removal flags, rebuild status,
// manifest, eval results) or the lightweight retrieval-usage counter
// maintained by retrieve.ts. NOTHING IS FABRICATED: if a source has never
// been retrieved, its counter reads 0; if the eval never ran, the eval
// block is null and the UI says so.
//
// All files live under data/corpus/ (gitignored runtime data — the
// manifest.json is the only committed version record). Deploy PR: the
// retrieval counters live in Postgres (corpus_retrieval_usage) whenever a
// database is configured — one atomic upsert per retrieval, exact across
// replicas; the JSON file remains only for installs without a database.

import fs from "node:fs";
import path from "node:path";
import { corpusDir } from "./store";
import { listProposed, listRemovals, readRebuildStatus, type RebuildStatus } from "./proposals";
import type { CorpusManifest } from "./types";

// ── Eval summary (scripts/eval-corpus.mts output) ────────────────────────────

export interface EvalSummary {
  precision: number;
  questions: number;
  correct: number;
  runAt: string;
  /** sourceId → number of eval questions where it was the top source. */
  hitsBySource: Map<string, number>;
}

export function loadEvalSummary(): EvalSummary | null {
  try {
    const p = path.join(corpusDir(), "eval-results.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
      precision?: number;
      questions?: number;
      ranAt?: string;
      results?: Array<{ correct?: boolean; topSourceId?: string }>;
    };
    if (typeof raw.precision !== "number" || typeof raw.ranAt !== "string") return null;
    const results = Array.isArray(raw.results) ? raw.results : [];
    const hitsBySource = new Map<string, number>();
    let correct = 0;
    for (const r of results) {
      if (r.correct) correct++;
      if (r.topSourceId) hitsBySource.set(r.topSourceId, (hitsBySource.get(r.topSourceId) ?? 0) + 1);
    }
    return {
      precision: raw.precision,
      questions: typeof raw.questions === "number" ? raw.questions : results.length,
      correct,
      runAt: raw.ranAt,
      hitsBySource,
    };
  } catch {
    return null;
  }
}

// ── Retrieval usage counter ────────────────────────────────────────────────
// Incremented by retrieve.ts on every real retrieval hit (per sourceId).
// Best-effort: a counter failure must never break retrieval.

export interface UsageRecord {
  hits: number;
  lastHit: string;
}

function usagePath(): string {
  return path.join(corpusDir(), "retrieval-usage.json");
}

function readRetrievalUsageFile(): Map<string, UsageRecord> {
  try {
    const p = usagePath();
    if (!fs.existsSync(p)) return new Map();
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, UsageRecord>;
    const out = new Map<string, UsageRecord>();
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.hits === "number") out.set(k, { hits: v.hits, lastHit: v.lastHit ?? "" });
    }
    return out;
  } catch {
    return new Map();
  }
}

const useDb = () => !!process.env.DATABASE_URL?.trim();

/** Per-source counters from Postgres (or the file without a database). Never throws. */
export async function readRetrievalUsage(): Promise<Map<string, UsageRecord>> {
  if (!useDb()) return readRetrievalUsageFile();
  try {
    const { prisma } = await import("@/lib/prisma");
    const rows = await prisma.corpusRetrievalUsage.findMany();
    return new Map(rows.map((r) => [r.sourceId, { hits: r.hits, lastHit: r.lastHitAt.toISOString() }]));
  } catch {
    return new Map();
  }
}

/** Increment per-source retrieval counters. Never throws. */
export async function recordRetrievalHits(sourceIds: string[]): Promise<void> {
  const ids = sourceIds.filter(Boolean);
  if (!ids.length) return;
  if (!useDb()) return recordRetrievalHitsFile(ids);
  try {
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const keys = [...counts.keys()];
    const hits = keys.map((k) => counts.get(k)!);
    const { prisma } = await import("@/lib/prisma");
    await prisma.$executeRaw`
      INSERT INTO "corpus_retrieval_usage" ("source_id", "hits", "last_hit_at")
      SELECT k, h, now() FROM unnest(${keys}::text[], ${hits}::int[]) AS t(k, h)
      ON CONFLICT ("source_id") DO UPDATE
        SET "hits" = "corpus_retrieval_usage"."hits" + EXCLUDED."hits", "last_hit_at" = EXCLUDED."last_hit_at"`;
  } catch {
    /* usage tracking is best-effort; retrieval must never fail because of it */
  }
}

/** File fallback (no database): increment per-source retrieval counters. Never throws. */
function recordRetrievalHitsFile(sourceIds: string[]): void {
  try {
    if (!sourceIds.length) return;
    const usage = readRetrievalUsageFile();
    const now = new Date().toISOString();
    for (const id of sourceIds) {
      if (!id) continue;
      const cur = usage.get(id);
      usage.set(id, { hits: (cur?.hits ?? 0) + 1, lastHit: now });
    }
    fs.mkdirSync(corpusDir(), { recursive: true });
    fs.writeFileSync(usagePath(), JSON.stringify(Object.fromEntries(usage), null, 2));
  } catch {
    /* usage tracking is best-effort; retrieval must never fail because of it */
  }
}

// ── Activity feed ──────────────────────────────────────────────────────────

export type ActivityEventType = "proposal" | "removal-flag" | "rebuild" | "manifest";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  /** ISO timestamp; used for desc sorting. */
  at: string;
  title: string;
  detail?: string;
  actor?: string;
}

/**
 * Assemble the corpus activity feed from real runtime state: proposals,
 * removal flags, rebuild job history, and the manifest version record.
 * Sorted newest-first, capped at 50.
 */
export function buildActivityEvents(manifest: CorpusManifest | null): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const p of listProposed()) {
    events.push({
      id: `proposal:${p.id}`,
      type: "proposal",
      at: p.createdAt,
      title: `Source proposed: ${p.title}`,
      detail: `via ${p.kind}${p.url ? ` — ${p.url}` : ""}${p.note ? ` — ${p.note}` : ""}`,
      actor: p.createdBy,
    });
  }

  for (const [id, r] of Object.entries(listRemovals())) {
    events.push({
      id: `flag:${id}:${r.flaggedAt}`,
      type: "removal-flag",
      at: r.flaggedAt,
      title: `Removal flagged: ${id}`,
      detail: r.reason,
      actor: r.flaggedBy,
    });
  }

  const rebuild: RebuildStatus = readRebuildStatus();
  if (rebuild.startedAt) {
    const done = rebuild.state === "succeeded" || rebuild.state === "failed";
    events.push({
      id: `rebuild:${rebuild.startedAt}`,
      type: "rebuild",
      at: rebuild.finishedAt ?? rebuild.startedAt,
      title:
        rebuild.state === "running"
          ? "Corpus rebuild started"
          : `Corpus rebuild ${rebuild.state}`,
      detail: done
        ? `finished ${rebuild.finishedAt ?? "unknown"}${rebuild.error ? ` — ${rebuild.error}` : ""}`
        : "in progress",
    });
  }

  if (manifest) {
    events.push({
      id: `manifest:v${manifest.corpusVersion}`,
      type: "manifest",
      at: manifest.updatedAt,
      title: `Corpus manifest v${manifest.corpusVersion}`,
      detail: `${manifest.sources.length} sources · ${(manifest.assets.main + manifest.assets["by-sa"]).toLocaleString()} chunks`,
    });
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, 50);
}

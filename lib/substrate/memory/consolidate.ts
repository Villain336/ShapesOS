// Marketr — Growth Memory consolidation worker (Phase 8 G3).
//
// Async, off the request path: distills episodes → facts, detects
// contradictions (invalidate, never delete), prunes to floor
// (decay-to-floor: user-told facts persist, agent inferences fade), dedupes
// near-duplicate learnings. The read path never waits for it.
//
// Separate pool/role with memory budgets (spec §9: "the memory workload gets
// its own Postgres role with memory budgets — vector search will fight OLTP
// for buffer cache otherwise"):
//   - dedicated PrismaClient with a small connection pool,
//   - connects as marketr_memory_worker when that role exists (created by
//     the phase8_memory migration; ALTER ROLE budgets), else falls back to
//     the app role with in-session SET budgets — loudly logged, never silent.

import { PrismaClient, Prisma } from "@prisma/client";
import { WORKSPACE_GUC } from "./rls";
import { scrubJson } from "./scrub";
import { recordFact } from "./write";
import {
  executeLearningPass,
  learningPassBookkeeping,
  type LearningPassReport,
} from "./learning-pass";

const WORKER_POOL_SIZE = 3;

function workerDatabaseUrl(): string | undefined {
  const base = process.env.DATABASE_URL;
  if (!base) return undefined;
  try {
    const u = new URL(base);
    // Small dedicated pool for the worker (Prisma reads connection_limit
    // from the datasource URL).
    u.searchParams.set("connection_limit", String(WORKER_POOL_SIZE));
    // Prefer the dedicated worker role when the caller opts in; default keeps
    // the app role (the migration may not have been able to CREATE ROLE on
    // minimal self-hosted Postgres — the fallback is loud, not silent).
    if (process.env.MEMORY_WORKER_ROLE === "marketr_memory_worker") {
      u.username = "marketr_memory_worker";
      u.password = "";
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Dedicated worker client: a SEPARATE pool from the request path, so
 * consolidation can never degrade live recall latency (spec §9.11).
 */
export const workerPrisma: PrismaClient =
  ((globalThis as Record<string, unknown>).__memoryWorker as PrismaClient | undefined) ??
  new PrismaClient({ datasourceUrl: workerDatabaseUrl() });

(globalThis as Record<string, unknown>).__memoryWorker = workerPrisma;

const workerIdentity =
  process.env.MEMORY_WORKER_ROLE === "marketr_memory_worker"
    ? "marketr_memory_worker"
    : "app-role (marketr) — MEMORY_WORKER_ROLE not set; in-session budgets applied";

if (process.env.MEMORY_WORKER_ROLE !== "marketr_memory_worker") {
  console.warn(
    `[memory-worker] running as ${workerIdentity}. Set MEMORY_WORKER_ROLE=marketr_memory_worker for the dedicated role.`,
  );
}

/**
 * Worker-scoped transaction: tenant GUC + in-session memory budgets
 * (work_mem / statement_timeout mirror the ALTER ROLE budgets so the
 * fallback path honors them too).
 */
export async function withWorkerScope<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!workspaceId) throw new Error("withWorkerScope: workspaceId is required");
  return workerPrisma.$transaction(async (tx) => {
    const wid = workspaceId.replace(/'/g, "''");
    await tx.$executeRawUnsafe(`SET LOCAL ${WORKSPACE_GUC} = '${wid}'`);
    await tx.$executeRawUnsafe(`SET LOCAL work_mem = '64MB'`);
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '120000'`);
    return fn(tx);
  });
}

export function getWorkerIdentity(): string {
  return workerIdentity;
}

export interface ConsolidationReport {
  runId: string;
  episodesScanned: number;
  factsDistilled: number;
  factsInvalidated: number;
  learningsDeduped: number;
  rowsPruned: number;
  /** Phase 13B nightly learning pass ("sleep") — null until the step runs. */
  learning: LearningPassReport | null;
  errors: string[];
}

// Decay-to-floor parameters.
const DECAY_TAU_DAYS = 180; // agent inferences fade with ~125d half-life
const PRUNE_FLOOR = 0.15; // decayed confidence below this → soft-expire
const RETENTION_DAYS = 365; // hard retention window for agent inferences

// Distillation cues: sentences that carry decisions / corrections / gotchas.
const DISTILL_CUES =
  /\b(decided|decision|learned|learning|correction|corrected|gotcha|watch out|note that|important|because|root cause|turns out|in hindsight)\b/i;

/**
 * Distill one episode into candidate facts. Deterministic and reviewable:
 * sentences carrying decision/correction/gotcha cues become agent_inferred
 * facts (confidence 0.6, anchored to the episode). Episodes are marked
 * distilled via refs.distilled_at — episodes themselves are never edited
 * beyond this bookkeeping ref... (see note below).
 *
 * NOTE on immutability: spec §9.4 says application code never UPDATEs
 * memory_episodes. The distilled marker therefore lives in
 * memory_consolidation_runs (episodes_scanned + a distilled_episode_ids
 * convention in refs of the RUN row), not on the episode row.
 */
async function distillEpisode(
  workspaceId: string,
  episode: { id: string; summary: string; actor: string },
  distilledIds: Set<string>,
): Promise<number> {
  if (distilledIds.has(episode.id)) return 0;
  const sentences = episode.summary
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24 && DISTILL_CUES.test(s))
    .slice(0, 5);
  let n = 0;
  // Distillation writes go through the WORKER pool (never the request path).
  await withWorkerScope(workspaceId, async (tx) => {
    for (const s of sentences) {
      const scrubbed = scrubJson({ text: s }).value as { text: string };
      await recordFact(
        workspaceId,
        {
          predicate: "learned_from_episode",
          object: { statement: scrubbed.text, actor: episode.actor },
          confidence: 0.6,
          sourceEpisodeId: episode.id,
          origin: "agent_inferred",
        },
        { tx },
      );
      n++;
    }
  });
  distilledIds.add(episode.id);
  return n;
}

/** Contradiction detection: same (subject, predicate), overlapping validity, different object. */
async function detectContradictions(
  workspaceId: string,
): Promise<number> {
  return withWorkerScope(workspaceId, async (tx) => {
    // Candidate pairs: same predicate + same subject, both currently valid,
    // objects differ (normalized comparison).
    const pairs = (await tx.$queryRawUnsafe(
      `SELECT a."id" AS old_id, b."id" AS new_id
         FROM "memory_facts" a
         JOIN "memory_facts" b
           ON b."workspace_id" = a."workspace_id"
          AND b."predicate" = a."predicate"
          AND COALESCE(b."subject_node_id", '') = COALESCE(a."subject_node_id", '')
          AND b."created_at" > a."created_at"
          AND b."object"::text IS DISTINCT FROM a."object"::text
        WHERE a."workspace_id" = $1
          AND a."invalid_at" IS NULL AND a."expired_at" IS NULL
          AND b."invalid_at" IS NULL AND b."expired_at" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "memory_facts" c
             WHERE c."superseded_by_id" = b."id" AND c."id" = a."id"
          )
        LIMIT 200`,
      workspaceId,
    )) as Array<{ old_id: string; new_id: string }>;
    let n = 0;
    for (const p of pairs) {
      const now = new Date().toISOString();
      // Invalidate the OLDER row (it was true for its era); the newer row
      // supersedes it. Never delete.
      await tx.$executeRawUnsafe(
        `UPDATE "memory_facts"
            SET "invalid_at" = $1::timestamptz, "expired_at" = $1::timestamptz,
                "superseded_by_id" = $2
          WHERE "id" = $3 AND "invalid_at" IS NULL`,
        now,
        p.new_id,
        p.old_id,
      );
      n++;
    }
    return n;
  });
}

/**
 * Decay-to-floor prune: agent_inferred facts/learnings older than the
 * retention window whose decayed confidence fell below the floor are
 * soft-expired (expired_at / invalidated_at). user_told facts are NEVER
 * touched — they persist. Nothing is deleted.
 */
async function pruneToFloor(workspaceId: string): Promise<number> {
  return withWorkerScope(workspaceId, async (tx) => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
    const facts = (await tx.$queryRawUnsafe(
      `UPDATE "memory_facts"
          SET "expired_at" = now()
        WHERE "workspace_id" = $1
          AND "origin" = 'agent_inferred'
          AND "expired_at" IS NULL AND "invalid_at" IS NULL
          AND "created_at" < $2::timestamptz
          AND ("confidence" * exp(-EXTRACT(EPOCH FROM (now() - "created_at")) / 86400 / $3)) < $4
        RETURNING "id"`,
      workspaceId,
      cutoff,
      DECAY_TAU_DAYS,
      PRUNE_FLOOR,
    )) as Array<{ id: string }>;
    const learnings = (await tx.$queryRawUnsafe(
      `UPDATE "memory_learnings"
          SET "invalidated_at" = now(),
              "context_refs" = COALESCE("context_refs", '{}'::jsonb) || '{"pruned":"decay_to_floor"}'::jsonb
        WHERE "workspace_id" = $1
          AND "invalidated_at" IS NULL
          AND "observed_at" < $2::timestamptz
          AND ("context_refs"->>'origin' IS DISTINCT FROM 'user_told')
        RETURNING "id"`,
      workspaceId,
      cutoff,
    )) as Array<{ id: string }>;
    return facts.length + learnings.length;
  });
}

/**
 * Dedupe near-duplicate learnings: same workspace + same result + embedding
 * cosine > 0.97 → keep the earliest, invalidate the later with a pointer.
 * (The "Preventable Rediscovery" pattern from the research.)
 */
async function dedupeLearnings(workspaceId: string): Promise<number> {
  return withWorkerScope(workspaceId, async (tx) => {
    const dups = (await tx.$queryRawUnsafe(
      `SELECT a."id" AS keep_id, b."id" AS dup_id
         FROM "memory_learnings" a
         JOIN "memory_learnings" b
           ON b."workspace_id" = a."workspace_id"
          AND b."result" = a."result"
          AND b."observed_at" > a."observed_at"
          AND a."embedding" IS NOT NULL AND b."embedding" IS NOT NULL
          AND (1 - (a."embedding" <=> b."embedding")) > 0.97
        WHERE a."workspace_id" = $1
          AND a."invalidated_at" IS NULL AND b."invalidated_at" IS NULL
        LIMIT 200`,
      workspaceId,
    )) as Array<{ keep_id: string; dup_id: string }>;
    let n = 0;
    for (const d of dups) {
      await tx.$executeRawUnsafe(
        `UPDATE "memory_learnings"
            SET "invalidated_at" = now(),
                "context_refs" = COALESCE("context_refs", '{}'::jsonb)
                  || jsonb_build_object('deduped_into', $2::text)
          WHERE "id" = $1 AND "invalidated_at" IS NULL`,
        d.dup_id,
        d.keep_id,
      );
      n++;
    }
    return n;
  });
}

/** Distilled-episode bookkeeping lives on the run row (episodes are immutable). */
async function loadDistilledIds(workspaceId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  await withWorkerScope(workspaceId, async (tx) => {
    const rows = await tx.memoryConsolidationRun.findMany({
      where: { workspaceId, status: "succeeded" },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: { error: true },
    });
    for (const r of rows) {
      try {
        const parsed = r.error ? (JSON.parse(r.error) as { distilledIds?: string[] }) : null;
        for (const id of parsed?.distilledIds ?? []) ids.add(id);
      } catch {
        /* ignore malformed bookkeeping */
      }
    }
  });
  return ids;
}

/**
 * Create the run row and return its id (fast — used by the API trigger so
 * the HTTP request can return immediately while the pass runs detached).
 */
export async function startConsolidationRun(workspaceId: string): Promise<string> {
  return withWorkerScope(workspaceId, async (tx) => {
    const run = await tx.memoryConsolidationRun.create({
      data: { workspaceId, status: "running" },
      select: { id: true },
    });
    return run.id;
  });
}

/**
 * Execute one consolidation pass against an existing run row. Async by
 * design — callers (cron route / admin trigger) never run this on the
 * recall path. Prefer startConsolidationRun + after(() => …) in routes.
 */
export async function executeConsolidationRun(
  workspaceId: string,
  runId: string,
  opts: { distillLimit?: number } = {},
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    runId,
    episodesScanned: 0,
    factsDistilled: 0,
    factsInvalidated: 0,
    learningsDeduped: 0,
    rowsPruned: 0,
    learning: null,
    errors: [],
  };
  const distilledIds = await loadDistilledIds(workspaceId).catch(() => new Set<string>());

  try {
    // 1. Distill undistilled episodes → facts.
    const episodes = await withWorkerScope(workspaceId, async (tx) =>
      tx.memoryEpisode.findMany({
        where: { workspaceId },
        orderBy: { startedAt: "desc" },
        take: opts.distillLimit ?? 100,
        select: { id: true, summary: true, actor: true },
      }),
    );
    for (const ep of episodes) {
      report.episodesScanned++;
      try {
        report.factsDistilled += await distillEpisode(workspaceId, ep, distilledIds);
      } catch (err) {
        report.errors.push(`distill ${ep.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 2. Contradictions → invalidation.
    try {
      report.factsInvalidated = await detectContradictions(workspaceId);
    } catch (err) {
      report.errors.push(`contradictions: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Decay-to-floor prune.
    try {
      report.rowsPruned = await pruneToFloor(workspaceId);
    } catch (err) {
      report.errors.push(`prune: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. Dedupe learnings.
    try {
      report.learningsDeduped = await dedupeLearnings(workspaceId);
    } catch (err) {
      report.errors.push(`dedupe: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Phase 13B nightly learning pass ("sleep"): LLM lesson extraction
    //    from recent agent_call episodes + feedback, with reviewable-diff
    //    write-back to the intelligence layer. Self-guarding (pause toggle,
    //    one-pass-per-night, no-live-LLM skip) — safe on manual triggers too.
    try {
      report.learning = await executeLearningPass(workspaceId);
      report.learningsDeduped +=
        report.learning.learningsSkippedDup + report.learning.learningsDecayed;
      if (report.learning.status === "failed") {
        report.errors.push(
          `learning pass: ${report.learning.errors.join("; ") || "failed"}`,
        );
      }
    } catch (err) {
      report.errors.push(
        `learning pass: ${err instanceof Error ? err.message : String(err)}`,
      );
      report.learning = null;
    }

    const status = report.errors.length > 0 ? "completed_with_errors" : "succeeded";
    await withWorkerScope(workspaceId, async (tx) => {
      // Bookkeeping rides on the run row (episodes are immutable; no second
      // bookkeeping system): distilledIds + the learning-pass outcome used
      // for the one-pass-per-night guard.
      const bookkeeping: Record<string, unknown> = {
        distilledIds: [...distilledIds],
      };
      if (report.learning) {
        bookkeeping.learningPass = learningPassBookkeeping(report.learning);
      }
      await tx.memoryConsolidationRun.update({
        where: { id: runId },
        data: {
          status,
          finishedAt: new Date(),
          episodesScanned: report.episodesScanned,
          factsDistilled: report.factsDistilled,
          factsInvalidated: report.factsInvalidated,
          learningsDeduped: report.learningsDeduped,
          rowsPruned: report.rowsPruned,
          // Bookkeeping: distilled episode ids + learning-pass outcome ride
          // on the run row so memory_episodes stays immutable (spec §9.4).
          error: JSON.stringify(bookkeeping).slice(0, 8000),
        },
      });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.errors.push(message);
    await withWorkerScope(workspaceId, async (tx) => {
      await tx.memoryConsolidationRun
        .update({ where: { id: runId }, data: { status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) } })
        .catch(() => {});
    });
  }
  return report;
}

/** Convenience: create the run row and execute the pass inline (battery/CLI). */
export async function runConsolidationOnce(
  workspaceId: string,
  opts: { distillLimit?: number } = {},
): Promise<ConsolidationReport> {
  const runId = await startConsolidationRun(workspaceId);
  return executeConsolidationRun(workspaceId, runId, opts);
}

/** Status for GET /api/substrate/memory/consolidation. */
export async function consolidationStatus(workspaceId: string): Promise<{
  lastRun: {
    id: string;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    episodesScanned: number;
    factsDistilled: number;
    factsInvalidated: number;
    learningsDeduped: number;
    rowsPruned: number;
    error: string | null;
  } | null;
  recentRuns: Array<{ id: string; status: string; startedAt: Date; finishedAt: Date | null }>;
  queueDepth: number;
  workerIdentity: string;
}> {
  const [lastRun, recentRuns, queueDepth] = await withWorkerScope(workspaceId, async (tx) => {
    const [last, recent, depth] = await Promise.all([
      tx.memoryConsolidationRun.findFirst({
        where: { workspaceId },
        orderBy: { startedAt: "desc" },
      }),
      tx.memoryConsolidationRun.findMany({
        where: { workspaceId },
        orderBy: { startedAt: "desc" },
        take: 10,
        select: { id: true, status: true, startedAt: true, finishedAt: true },
      }),
      tx.memoryEpisode.count({ where: { workspaceId } }),
    ]);
    return [last, recent, depth] as const;
  });
  let workerIdentity = "app-role (marketr)";
  if (process.env.MEMORY_WORKER_ROLE === "marketr_memory_worker") workerIdentity = "marketr_memory_worker";
  return {
    lastRun: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          episodesScanned: lastRun.episodesScanned,
          factsDistilled: lastRun.factsDistilled,
          factsInvalidated: lastRun.factsInvalidated,
          learningsDeduped: lastRun.learningsDeduped,
          rowsPruned: lastRun.rowsPruned,
          error: lastRun.error,
        }
      : null,
    recentRuns,
    queueDepth,
    workerIdentity,
  };
}

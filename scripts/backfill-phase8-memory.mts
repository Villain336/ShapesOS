#!/usr/bin/env tsx
// Marketr — Phase 8 G3 backfill: experiment_results + Intelligence Report
// opportunity outcomes → Growth Memory (SPEC §9.10).
//
// Idempotent and provenance-preserving:
//   - experiment_results: only rows with a verdict and archived_to_memory=false
//     are backfilled; the row is marked archived_to_memory=true afterwards.
//     A second guard checks for an existing learning with
//     context_refs->>'experimentResultId' before writing.
//   - intelligence_reports: each opportunity carrying an explicit outcome is
//     backfilled once, keyed by context_refs->>'backfillKey'.
// Every write goes through the same scrubbed write path as live ingestion,
// so secrets never land in memory and embeddings are always attached.
// Provenance rides in context_refs (source:"backfill", source ids, mapping
// version).
//
// Usage:
//   tsx scripts/backfill-phase8-memory.mts [--dry-run] [--workspace <id>]
//   MEMORY_TEST_MODE=1 tsx scripts/backfill-phase8-memory.mts --dry-run

import { prisma } from "../lib/prisma";
import { recordEpisode, recordLearning } from "../lib/substrate/memory/write";
import type { MemoryLearningResult } from "../lib/substrate/memory/types";

const BACKFILL_VERSION = "phase8-memory-backfill/v1";

interface Counts {
  experimentResults: { scanned: number; backfilled: number; skipped: number };
  opportunities: { scanned: number; backfilled: number; skipped: number };
  errors: string[];
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const WS_FILTER = (() => {
  const i = args.indexOf("--workspace");
  return i >= 0 ? args[i + 1] : undefined;
})();

const verdictToResult = (verdict: string | null | undefined): MemoryLearningResult | null => {
  switch ((verdict ?? "").toLowerCase()) {
    case "winner":
      return "worked";
    case "loser":
      return "failed";
    case "inconclusive":
    case "compromised":
      return "inconclusive";
    default:
      return null;
  }
};

async function learningExists(workspaceId: string, key: string, field: string): Promise<boolean> {
  const row = await prisma.memoryLearning.findFirst({
    where: { workspaceId, contextRefs: { path: [field], equals: key } },
    select: { id: true },
  });
  return row != null;
}

async function backfillExperimentResults(counts: Counts): Promise<void> {
  const rows = await prisma.experimentResult.findMany({
    where: {
      verdict: { not: null },
      archivedToMemory: false,
      ...(WS_FILTER ? { experiment: { workspaceId: WS_FILTER } } : {}),
    },
    include: { experiment: true },
    take: 500,
  });
  for (const r of rows) {
    counts.experimentResults.scanned++;
    const result = verdictToResult(r.verdict);
    if (!result) {
      counts.experimentResults.skipped++;
      continue;
    }
    const ws = r.experiment.workspaceId;
    const key = `experiment-result:${r.id}`;
    try {
      if (await learningExists(ws, key, "experimentResultId")) {
        counts.experimentResults.skipped++;
        if (!DRY_RUN) await prisma.experimentResult.update({ where: { id: r.id }, data: { archivedToMemory: true } });
        continue;
      }
      if (DRY_RUN) {
        counts.experimentResults.backfilled++;
        continue;
      }
      const stats = (r.statsJson ?? {}) as Record<string, unknown>;
      const episode = await recordEpisode(ws, {
        actor: "agent",
        episodeType: "run",
        summary:
          `Backfilled Test Lab experiment ${r.experimentId} (${r.experiment.hypothesis.slice(0, 200)}) ` +
          `with verdict ${r.verdict}.`.slice(0, 2000),
        refs: {
          source: "import",
          backfillVersion: BACKFILL_VERSION,
          experimentId: r.experimentId,
          experimentResultId: r.id,
        },
      });
      await recordLearning(ws, {
        hypothesis: r.experiment.hypothesis.slice(0, 4000),
        action: `Ran experiment ${r.experimentId} on ${r.experiment.channel} (${r.experiment.primaryMetric}).`.slice(0, 4000),
        result,
        sourceEpisodeId: episode.id,
        source: "import",
        contextRefs: {
          source: "import",
          backfillVersion: BACKFILL_VERSION,
          backfillKey: key,
          experimentId: r.experimentId,
          experimentResultId: r.id,
          verdict: r.verdict,
          expectedUplift: stats.expected_uplift ?? null,
          chanceToBeat: stats.prob_to_beat ?? null,
        },
      });
      await prisma.experimentResult.update({ where: { id: r.id }, data: { archivedToMemory: true } });
      counts.experimentResults.backfilled++;
    } catch (err) {
      counts.errors.push(`experiment_result ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

interface OpportunityLike {
  title?: string;
  name?: string;
  outcome?: string;
  result?: string;
  status?: string;
  recommendation?: string;
  description?: string;
}

const outcomeToResult = (o: OpportunityLike): MemoryLearningResult | null => {
  const raw = `${o.outcome ?? ""} ${o.result ?? ""} ${o.status ?? ""}`.toLowerCase();
  if (/(won|success|implement|complet|shipped|positive)/.test(raw)) return "worked";
  if (/(lost|fail|reject|kill|abandon|negative)/.test(raw)) return "failed";
  if (/(inconclusive|unclear|partial|mixed)/.test(raw)) return "inconclusive";
  return null; // no explicit outcome → do not backfill
};

async function backfillIntelligenceReports(counts: Counts): Promise<void> {
  const reports = await prisma.intelligenceReport.findMany({
    where: {
      status: { in: ["ready"] },
      ...(WS_FILTER ? { workspaceId: WS_FILTER } : {}),
    },
    take: 200,
  });
  for (const rep of reports) {
    let opps: OpportunityLike[] = [];
    try {
      const raw = rep.opportunitiesJson as unknown;
      opps = Array.isArray(raw) ? (raw as OpportunityLike[]) : [];
    } catch {
      continue;
    }
    for (let i = 0; i < opps.length; i++) {
      const opp = opps[i]!;
      counts.opportunities.scanned++;
      const result = outcomeToResult(opp);
      if (!result) {
        counts.opportunities.skipped++;
        continue;
      }
      const key = `ir:${rep.id}:opp:${i}`;
      try {
        if (await learningExists(rep.workspaceId, key, "backfillKey")) {
          counts.opportunities.skipped++;
          continue;
        }
        if (DRY_RUN) {
          counts.opportunities.backfilled++;
          continue;
        }
        const title = (opp.title ?? opp.name ?? `opportunity ${i + 1}`).slice(0, 500);
        const episode = await recordEpisode(rep.workspaceId, {
          actor: "agent",
          episodeType: "sync",
          summary: `Backfilled Intelligence Report opportunity outcome: ${title}. Outcome: ${opp.outcome ?? opp.result ?? opp.status}`.slice(0, 2000),
          refs: {
            source: "import",
            backfillVersion: BACKFILL_VERSION,
            intelligenceReportId: rep.id,
            backfillKey: key,
          },
        });
        await recordLearning(rep.workspaceId, {
          hypothesis: title.slice(0, 4000),
          action: (opp.recommendation ?? opp.description ?? "Intelligence Report opportunity").slice(0, 4000),
          result,
          sourceEpisodeId: episode.id,
          source: "import",
          contextRefs: {
            source: "import",
            backfillVersion: BACKFILL_VERSION,
            backfillKey: key,
            intelligenceReportId: rep.id,
            reportVersion: rep.version,
            outcome: opp.outcome ?? opp.result ?? opp.status,
          },
        });
        counts.opportunities.backfilled++;
      } catch (err) {
        counts.errors.push(`intelligence_report ${rep.id} opp ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const counts: Counts = {
    experimentResults: { scanned: 0, backfilled: 0, skipped: 0 },
    opportunities: { scanned: 0, backfilled: 0, skipped: 0 },
    errors: [],
  };
  console.log(`[backfill] ${DRY_RUN ? "DRY RUN" : "LIVE"} ${WS_FILTER ? `workspace=${WS_FILTER}` : "all workspaces"}`);
  await backfillExperimentResults(counts);
  await backfillIntelligenceReports(counts);
  console.log("[backfill] experiment_results:", counts.experimentResults);
  console.log("[backfill] opportunities:   ", counts.opportunities);
  if (counts.errors.length > 0) {
    console.log(`[backfill] ${counts.errors.length} errors:`);
    for (const e of counts.errors.slice(0, 20)) console.log("  -", e);
    process.exitCode = 1;
  } else {
    console.log("[backfill] done, no errors.");
  }
}

main()
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

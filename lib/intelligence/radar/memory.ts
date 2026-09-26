// Marketr — Phase 10 M2: Growth Memory writer.
//
// Writes structured platform events to Growth Memory (Phase 8) so the Chief
// Strategy Agent (Phase 9) can reason about update exposure inside Missions.
//
// Schema (follows the existing memory-event contract):
//   - ONE episode (actor "platform-radar", type "sync") per cron sweep that
//     found ≥1 confirmed rollout — the sweep's audit trail.
//   - ONE semantic fact per confirmed rollout: predicate
//     "platform_update.confirmed_rollout", object carries the event id/title/
//     window/source, impacted projects + pages, and top movers; confidence =
//     the classifier's confidence.
//   - docs_change events are NEVER written (selectivity discipline: the Chief
//     Strategy Agent doesn't need documentation edits).
//   - volatility readings ride in the episode's refs, not as facts.
//
// Embedding failures (local model not yet downloaded) skip memory writes
// with an honest reason instead of failing the whole sweep.

import { MemoryModelError } from "@/lib/substrate/memory/embed";
import { recordEpisode, recordFact } from "@/lib/substrate/memory/write";
import type { CorrelatedImpact, RadarAlert } from "./types";

export interface MemoryWriteOutcome {
  written: number;
  skippedReason: string | null;
}

function factObject(alert: RadarAlert): Record<string, unknown> {
  return {
    platform_event_id: alert.platformEventId,
    title: alert.eventTitle,
    started_at: alert.eventStartedAt,
    source: "platform-radar/m2",
    projects_impacted: alert.affectedProjects.map((p) => ({
      project_id: p.projectId,
      domain: p.domain,
      pages_impacted: p.impactedPages.length,
      top_movers: p.impactedPages.slice(0, 5).map((pg) => ({
        page: pg.page,
        impact_score: pg.impactScore,
        direction: pg.direction,
      })),
    })),
  };
}

export async function writeRolloutToMemory(
  workspaceId: string,
  alert: RadarAlert,
): Promise<MemoryWriteOutcome> {
  const totalPages = alert.affectedProjects.reduce(
    (n, p) => n + p.impactedPages.length,
    0,
  );
  const pageNoun = totalPages === 1 ? "page" : "pages";
  try {
    const { id: episodeId } = await recordEpisode(workspaceId, {
      episodeType: "sync",
      actor: "platform-radar",
      summary:
        `Platform radar sweep: confirmed rollout "${alert.eventTitle}" ` +
        `(${alert.eventStartedAt ?? "date unknown"}) impacted ${totalPages} ${pageNoun} ` +
        `across ${alert.affectedProjects.length} project(s). ` +
        `Headline: ${alert.headline}`,
      refs: {
        module: "phase10/m2",
        platform_event_id: alert.platformEventId,
        affected_projects: alert.affectedProjects.map((p) => p.projectId),
      },
    });
    await recordFact(
      workspaceId,
      {
        predicate: "platform_update.confirmed_rollout",
        object: factObject(alert),
        confidence: 0.9,
        validAt: alert.eventStartedAt ? new Date(alert.eventStartedAt) : new Date(),
        sourceEpisodeId: episodeId,
        origin: "agent_inferred",
      },
    );
    return { written: 2, skippedReason: null };
  } catch (err) {
    if (err instanceof MemoryModelError) {
      return {
        written: 0,
        skippedReason: `local embedding model unavailable — memory writes skipped honestly: ${err.message.slice(0, 160)}`,
      };
    }
    return {
      written: 0,
      skippedReason: `memory write failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Write one top mover as context for testing/backtests (pure helper). */
export function topMovers(impacts: CorrelatedImpact[], n = 5): CorrelatedImpact[] {
  return [...impacts].sort((a, b) => b.impactScore - a.impactScore).slice(0, n);
}

// Marketr — Phase 10 M2: the daily platform-radar sweep.
//
// Pipeline (per workspace):
//   1. Ingest official sources (status dashboard JSON, Search Central docs
//      RSS, Bing blog RSS) — failures per-source, never fatal.
//   2. Classify each item (rollout / docs_change / volatility); upsert.
//   3. For each CONFIRMED ROLLOUT event: build pre/post windows, pull each
//      GSC-connected project's deltas via M1's contract, flag only what
//      exceeds the noise band, write page_impact rows.
//   4. Write confirmed rollouts to Growth Memory (best-effort; skips honestly
//      when the local embedding model is unavailable).
//   5. Emit one structured alert per rollout through the alert hub
//      ("platform_rollout" trigger). docs_change / volatility NEVER alert.
//
// Invariants: official sources only; never alert on docs_change; never claim
// impact the data can't support; everything workspace-scoped via
// withWorkspaceScope.

import type { PlatformEventType } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import {
  buildRolloutAlert,
  emitRolloutAlert,
  isAlertableEventType,
  type ProjectImpactInput,
  type RolloutEventLike,
} from "./alerts";
import { buildWindows, flagImpacts, writeImpacts } from "./correlate";
import { classifyEvent } from "./classifier";
import {
  fetchAllSources,
  upsertEvents,
} from "./ingest";
import {
  listGscProjects,
  listWorkspaceProjects,
  resolveGscPort,
} from "./gsc-port";
import { writeRolloutToMemory } from "./memory";
import { getVolatilityReadings } from "./volatility";
import type { PreparedEvent, RadarRunResult } from "./types";

export async function runPlatformRadar(workspaceId: string): Promise<RadarRunResult> {
  const startedAt = new Date();
  const errors: string[] = [];

  // 1. Ingest --------------------------------------------------------------
  const { items, errors: fetchErrors } = await fetchAllSources();
  errors.push(...fetchErrors);

  // 2. Classify ------------------------------------------------------------
  const prepared: PreparedEvent[] = [];
  const classified = { rollout: 0, docs_change: 0, volatility: 0 };
  for (const item of items) {
    try {
      const classification = await classifyEvent(item);
      classified[classification.eventType] += 1;
      prepared.push({ ...item, classification });
    } catch (err) {
      errors.push(
        `classify failed for "${item.title.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { rows, ...upsertStats } = await upsertEvents(workspaceId, prepared);
  const ingested = {
    created: upsertStats.created,
    updated: upsertStats.updated,
    skipped: items.length - prepared.length,
  };

  // 3. Correlate rollouts ---------------------------------------------------
  const port = await resolveGscPort();
  let correlatedEvents = 0;
  let impactsWritten = 0;
  let alertsEmitted = 0;
  let memoryWrites = 0;
  let memorySkipped: string | null = null;

  const rolloutRows = rows.filter((r) => r.type === ("rollout" as PlatformEventType));
  if (rolloutRows.length > 0) {
    let gscProjects = await listGscProjects(workspaceId);
    if (gscProjects.length === 0) {
      // No GSC bindings yet — fall back to all workspace projects so the
      // port (or its future M1 implementation) decides per project.
      gscProjects = await listWorkspaceProjects(workspaceId);
    }
    for (const row of rolloutRows) {
      if (!isAlertableEventType(row.type)) continue; // belt-and-braces
      const ev = await loadEvent(workspaceId, row.id);
      if (!ev) continue;
      const windows = buildWindows({ startedAt: ev.startedAt, endedAt: ev.endedAt });
      if (!windows) {
        errors.push(`event "${ev.title.slice(0, 80)}" has no dates — correlation skipped honestly`);
        continue;
      }
      if (port.status !== "live") {
        errors.push(
          `event "${ev.title.slice(0, 80)}": GSC delta engine unavailable (${port.reason}) — correlation pending`,
        );
        continue;
      }
      const projectInputs: ProjectImpactInput[] = [];
      for (const proj of gscProjects) {
        try {
          const deltas = await port.computeDeltas(
            workspaceId,
            proj.projectId,
            windows.pre,
            windows.post,
          );
          const { impacts } = flagImpacts(deltas);
          impactsWritten += await writeImpacts(workspaceId, row.id, impacts);
          projectInputs.push({ projectId: proj.projectId, domain: proj.domain, impacts });
        } catch (err) {
          errors.push(
            `deltas failed for ${proj.domain}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      correlatedEvents += 1;

      // 4 + 5. Memory + alert ------------------------------------------------
      const alert = buildRolloutAlert(
        { id: row.id, title: ev.title, startedAt: ev.startedAt, url: ev.url } satisfies RolloutEventLike,
        projectInputs,
      );
      const mem = await writeRolloutToMemory(workspaceId, alert);
      memoryWrites += mem.written;
      if (mem.skippedReason && !memorySkipped) memorySkipped = mem.skippedReason;
      const emitted = await emitRolloutAlert(workspaceId, alert);
      if (emitted.error) errors.push(`alert hub error: ${emitted.error}`);
      if (emitted.emitted) alertsEmitted += 1;
    }
  }

  const volatility = await getVolatilityReadings();

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    workspaceId,
    ingested: { created: ingested.created, updated: ingested.updated, skipped: ingested.skipped },
    classified,
    correlatedEvents,
    impactsWritten,
    alertsEmitted,
    memoryWrites,
    memorySkipped,
    volatility,
    errors,
  };
}

async function loadEvent(
  workspaceId: string,
  id: string,
): Promise<{ title: string; startedAt: Date | null; endedAt: Date | null; url: string | null } | null> {
  return withWorkspaceScope(workspaceId, async (tx) =>
    tx.platformEvent.findUnique({
      where: { id },
      select: { title: true, startedAt: true, endedAt: true, url: true },
    }),
  );
}

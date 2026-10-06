// ShapesOS — Phase 17 (observability): POST /api/cron/ai-cache-health
//
// Auth (shared cron gate, lib/cron/gate.ts): CRON_SECRET sweeps every
// workspace with model calls in the last 24 h; a signed-in editor+ checks
// their own.
//
// When a workspace's 24 h cache-read share (usage_events llm_tokens:
// cache_read / all input tokens) falls below 60% on real traffic, its admins
// get one notification per day (lib/metering/ai-health.ts sweepCacheHealth →
// lib/notifications/producers.ts notifyCacheShareLow) — the sign that a cache
// breaker shipped (something dynamic went into the cached prefix).

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { sweepCacheHealth, workspacesWithLlmCalls, type CacheHealthResult } from "@/lib/metering/ai-health";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron ? await workspacesWithLlmCalls() : [gate.workspaceId!];
  const results: CacheHealthResult[] = [];
  for (const workspaceId of workspaceIds) {
    try {
      results.push(await sweepCacheHealth(workspaceId));
    } catch (err) {
      console.warn(`[ai-cache-health] ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return Response.json({ ok: true, workspaces: results.length, alerted: results.filter((r) => r.alerted).length, results });
}

// Marketr — Phase 10 M4: weekly competitor-fleet cron.
// POST /api/cron/fleet
//
// Auth (same pattern as /api/cron/decay):
//   1. Cron: Authorization: Bearer <CRON_SECRET> — runs the fleet for every
//      workspace with watches. Schedule weekly (see DEPLOY.md).
//   2. Signed-in session (editor+) — runs for the user's workspace only.
//
// Each workspace: discovery → change detection → AI summaries → weekly
// digest. The digest is surfaced via the live `competitor_radar` alert
// trigger (milestone-13 hub) — no new email sending (no approval-gated
// Phase 4/5 email path exists for digests; lib/mail is direct-mail).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { emitAlert } from "@/lib/alerts/evaluate";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { runFleetForWorkspace } from "@/lib/intelligence/fleet/run";
import { buildWeeklyDigest } from "@/lib/intelligence/fleet/digest";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const workspaces = isCron
    ? await prisma.competitorWatch.findMany({
        select: { workspaceId: true },
        distinct: ["workspaceId"],
      })
    : [{ workspaceId: sessionWorkspaceId! }];

  const results: Array<Record<string, unknown>> = [];
  for (const { workspaceId } of workspaces) {
    try {
      const fleet = await runFleetForWorkspace(workspaceId);
      const digest = await withWorkspaceScope(workspaceId, (tx) =>
        buildWeeklyDigest(tx, workspaceId),
      );

      // Surface the digest through the existing alert hub (best-effort).
      const t = digest.totals;
      try {
        await emitAlert({
          workspaceId,
          trigger: "competitor_radar",
          severity: t.pricingOfferChanges > 0 ? "warn" : "info",
          title: `Weekly competitor digest: ${t.changes} changes across ${digest.competitors.length} competitors`,
          body:
            `Publishing velocity: +${t.pagesAdded} pages, ${t.pagesUpdated} updated, ${t.pagesRemoved} removed. ` +
            `Pricing/offer changes: ${t.pricingOfferChanges}. ` +
            (digest.serpAvailable
              ? `${digest.serpPresence.length} tracked keywords have a watched competitor in the top 10.`
              : `SERP vendor unavailable — keyword presence skipped this week.`),
          link: "/dashboard/intelligence/competitors",
          dedupKey: `fleet-digest:${new Date().toISOString().slice(0, 10)}`,
        });
      } catch {
        // alert hub failure never fails the fleet run
      }

      await auditEvent({
        projectId: null,
        workspaceId,
        action: "ai_proposal",
        actor: "ai",
        summary: `fleet weekly run: ${fleet.watches} watches, ${fleet.discovery.reduce((a, d) => a + d.rowsCreated, 0)} sitemap rows, ${fleet.detection.reduce((a, d) => a + d.changed, 0)} page changes, ${fleet.summarized} summaries`,
      }).catch(() => {});

      results.push({ workspaceId, ok: true, fleet, digest });
    } catch (err) {
      results.push({
        workspaceId,
        ok: false,
        error: err instanceof Error ? err.message : "fleet run failed",
      });
    }
  }

  return Response.json({ ok: true, results });
}

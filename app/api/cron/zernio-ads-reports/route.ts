// ShapesOS — Phase 15.4 (zernio): daily ad-report pull from Zernio.
// POST /api/cron/zernio-ads-reports
//
// Auth (either), same pattern as the other /api/cron/* routes (lib/cron/gate.ts):
//   1. Cron: Authorization: Bearer <CRON_SECRET> — every workspace with a
//      Zernio profile. Schedule daily (see DEPLOY.md): 40 5 * * *
//   2. Signed-in session (editor+) — the user's workspace only.
//
// Pulls the last 7 days of each workspace's campaign tree (getAdTree,
// ?profileId=<ours>&timeIncrement=1) into ad_reports, so the Advertising
// reports show Zernio's networks next to Amazon and StackAdapt. Reads only.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { activeZernioMode, getZernioClient } from "@/lib/zernio/config";
import { syncZernioAdReports } from "@/lib/zernio/reports";
import { getZernioScope } from "@/lib/zernio/tenancy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  if (activeZernioMode() === "off") return Response.json({ ok: true, skipped: "Zernio is not configured." });
  const client = getZernioClient();
  const to = new Date();
  const from = new Date(to.getTime() - 6 * 86_400_000);
  const range = { fromDate: from.toISOString().slice(0, 10), toDate: to.toISOString().slice(0, 10) };
  const workspaces = await prisma.workspace.findMany({ where: gate.isCron ? {} : { id: gate.workspaceId! }, select: { id: true } });
  const results: Array<{ workspaceId: string; campaigns?: number; upserted?: number; error?: string }> = [];
  for (const w of workspaces) {
    const has = await withWorkspaceScope(w.id, (tx) => tx.zernioProfile.findUnique({ where: { workspaceId_mode: { workspaceId: w.id, mode: client.mode } } }));
    if (!has) continue;
    try {
      const scope = await getZernioScope(w.id, { client, create: false });
      const r = await syncZernioAdReports(scope, range);
      results.push({ workspaceId: w.id, campaigns: r.campaigns, upserted: r.upserted });
    } catch (e) {
      results.push({ workspaceId: w.id, error: e instanceof Error ? e.message.slice(0, 200) : "sync failed" });
    }
  }
  return Response.json({ ok: true, range, results });
}

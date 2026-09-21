// Marketr — scheduled fix-agent runs (milestone 10).
// POST /api/cron/fix-agent
//
// Auth (either), same pattern as the rank-check cron (milestone 5):
//   1. Signed-in session — runs every enabled site in the user's projects.
//   2. Cron:  Authorization: Bearer <CRON_SECRET>  (CRON_SECRET from env).
//      Instance-level secret — runs every enabled site across all projects.
//      Schedule it (cron, systemd timer, Vercel Cron) and document CRON_SECRET.
//
// For every site with fix-agent settings enabled: pick up eligible issues
// (per-issue approved, or category allow-listed and non-destructive) and
// apply them through the same pipeline as the on-demand run. Dry-run mode
// only stores diff previews for review — nothing is written.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSiteIdeProvider } from "@/lib/connectors/source";
import { runScheduledFixes } from "@/lib/audit/runner";

export const dynamic = "force-dynamic";

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  const isCron = cronAuthorized(req);
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const enabledSettings = await prisma.fixAgentSettings.findMany({
    where: {
      enabled: true,
      site: isCron
        ? undefined
        : { project: { workspace: { ownerUserId: user!.id } } },
    },
    include: { site: { include: { sftpConnection: true } } },
  });

  // Skip content-only sources (no file tree to fix).
  const sites = enabledSettings
    .map((s) => s.site)
    .filter((s) => s.sourceType !== "wordpress" && s.sourceType !== "webflow");

  const results: { siteId: string; siteName: string; ok: boolean; summary?: string; error?: string }[] = [];

  for (const site of sites) {
    try {
      const provider = await getSiteIdeProvider(site);
      const run = await runScheduledFixes({
        siteId: site.id,
        projectId: site.projectId,
        approvedBy: isCron ? "schedule" : user!.id,
        provider,
      });
      results.push({ siteId: site.id, siteName: site.name, ok: true, summary: run.summary });
    } catch (err) {
      results.push({
        siteId: site.id,
        siteName: site.name,
        ok: false,
        error: err instanceof Error ? err.message : "fix run failed",
      });
    }
  }

  return Response.json({ ok: true, sites: results.length, results });
}

// Marketr — weekly scheduled backlink refresh (milestone 15).
// POST /api/cron/backlinks
//
// Auth (either), same pattern as /api/cron/decay (milestone 14):
//   1. Signed-in session — refreshes the user's workspace projects.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — all projects with
//      backlinksEnabled. Schedule weekly (see DEPLOY.md).
//
// Cost discipline: every project pull goes through runBacklinkPull(), so the
// hard row cap and the workspace monthly spend cap are enforced before any
// paid API call. The cron uses a conservative default row limit.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { runBacklinkPull } from "@/lib/seo/backlink-pull";

export const dynamic = "force-dynamic";

/** Conservative weekly rows per project — ~$0.066/pull at current pricing
 *  ($0.024 list + 500 rows × $0.000036 + $0.024 summary). */
export const CRON_BACKLINK_ROWS = 500;

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

  const projects = await prisma.project.findMany({
    where: {
      backlinksEnabled: true,
      ...(isCron ? {} : { workspaceId: (await getOrCreateWorkspace(user!.id, user!.email)).id }),
    },
    select: { id: true, workspaceId: true, domain: true },
  });

  const results: Array<{ projectId: string; domain: string } & Record<string, unknown>> = [];
  for (const p of projects) {
    try {
      const result = await runBacklinkPull({
        workspaceId: p.workspaceId,
        projectId: p.id,
        target: p.domain,
        limit: CRON_BACKLINK_ROWS,
        actor: "cron",
      });
      results.push({ projectId: p.id, domain: p.domain, ...result });
    } catch (err) {
      results.push({
        projectId: p.id,
        domain: p.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "backlink refresh failed",
      });
    }
  }

  return Response.json({ ok: true, projects: results });
}

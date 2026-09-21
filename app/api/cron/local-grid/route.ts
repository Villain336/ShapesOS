// Marketr — weekly geo-grid runner (milestone 16).
// POST /api/cron/local-grid
//
// Auth (either), same pattern as /api/cron/decay:
//   1. Signed-in session — runs due grids for the user's workspace projects.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs for every due grid.
//      Schedule weekly (see DEPLOY.md).
//
// A grid is due when enabled, schedule=weekly, and lastRunAt is older than
// 7 days (or never ran). Cost caps are enforced per grid run in the service.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { runLocalGrid } from "@/lib/local/service";

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

  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const grids = await prisma.localGrid.findMany({
    where: {
      enabled: true,
      schedule: "weekly",
      OR: [{ lastRunAt: null }, { lastRunAt: { lt: weekAgo } }],
      ...(isCron ? {} : { project: { workspaceId: (await getOrCreateWorkspace(user!.id, user!.email)).id } }),
    },
    select: { id: true, name: true, projectId: true },
  });

  const results: Array<{ gridId: string; name: string } & Record<string, unknown>> = [];
  for (const g of grids) {
    try {
      const r = await runLocalGrid(g.id, isCron ? "cron" : `user:${user!.id}`);
      results.push({ gridId: g.id, name: g.name, ...r });
    } catch (err) {
      results.push({
        gridId: g.id,
        name: g.name,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown error",
      });
    }
  }
  return Response.json({ ran: results.length, results });
}

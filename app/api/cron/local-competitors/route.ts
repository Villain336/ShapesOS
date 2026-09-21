// Marketr — weekly local-competitor refresh (milestone 16).
// POST /api/cron/local-competitors
//
// Auth: signed-in session (own workspace) or CRON_SECRET bearer.
// Schedule weekly (see DEPLOY.md). Competitors refresh only when enabled.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { refreshLocalCompetitors } from "@/lib/local/service";

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

  const projects = await prisma.project.findMany({
    where: {
      ...(isCron ? {} : { workspaceId: (await getOrCreateWorkspace(user!.id, user!.email)).id }),
      localCompetitors: { some: { enabled: true } },
    },
    select: { id: true, domain: true },
  });

  const results: Array<{ projectId: string; domain: string } & Record<string, unknown>> = [];
  for (const p of projects) {
    try {
      const r = await refreshLocalCompetitors(p.id, isCron ? "cron" : `user:${user!.id}`);
      results.push({ projectId: p.id, domain: p.domain, ...r });
    } catch (err) {
      results.push({
        projectId: p.id,
        domain: p.domain,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown error",
      });
    }
  }
  return Response.json({ ran: results.length, results });
}

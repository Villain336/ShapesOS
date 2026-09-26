// Marketr — Phase 10 M1: on-demand GSC snapshot pull.
// POST /api/intelligence/rank/pull { projectId, granularity? }
// Pulls the last 48h (hourly) or last 30d (daily) of Search Analytics and
// stores gsc_snapshot rows. Requires the GSC connector bound to the project.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { pullSnapshots, type GscGranularity } from "@/lib/intelligence/gsc";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  let body: { projectId?: string; granularity?: GscGranularity };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const projectId = String(body.projectId ?? "");
  const granularity: GscGranularity = body.granularity === "daily" ? "daily" : "hourly";
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: workspace.id },
    select: { id: true, domain: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const end = new Date();
  const start = new Date(
    end.getTime() - (granularity === "hourly" ? 2 : 30) * 24 * 60 * 60 * 1000,
  );

  try {
    const result = await pullSnapshots(workspace.id, project.id, { start, end }, granularity);
    return Response.json({ ok: true, project: { id: project.id, domain: project.domain }, ...result });
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    const status = /not connected|reconnect/i.test(message) ? 409 : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}

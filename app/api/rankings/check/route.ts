// Marketr — run a rank check for tracked keywords (milestone 5).
// POST /api/rankings/check  { projectId }  or  { projectId: "all" }
//
// Auth (either):
//   1. Signed-in session (on-demand "Run rank check" button in the UI).
//      projectId is required and must belong to the user's workspace.
//   2. Cron:  Authorization: Bearer <CRON_SECRET>  (CRON_SECRET from env).
//      Instance-level secret, so { projectId: "all" } checks every project.
//      Documented in README ("Scheduled rank checks").
//
// For every tracked keyword: fetch the SERP snapshot via the existing
// serpResults() provider method, find the project's domain in the results,
// and write a Ranking row (position null when the domain isn't in the
// checked depth — recorded, never a crash). Movement alerts are computed
// against the previous check and returned in the response.

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import { recordUsage } from "@/lib/usage";
import { domainMatches, computeAlerts, type RankAlert } from "@/lib/rankings";

export const dynamic = "force-dynamic";

interface CheckResult {
  projectId: string;
  domain: string;
  checked: number;
  skipped: number;
  rankings: { keywordId: string; phrase: string; position: number | null; url: string | null }[];
  alerts: RankAlert[];
  mock: boolean;
}

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function checkProject(projectId: string): Promise<CheckResult> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const tracked = await prisma.keyword.findMany({
    where: { projectId, tracked: true },
    orderBy: { phrase: "asc" },
  });

  const provider = getSeoProvider();
  const status = providerStatus();
  const now = new Date();
  const result: CheckResult = {
    projectId,
    domain: project.domain,
    checked: 0,
    skipped: 0,
    rankings: [],
    alerts: [],
    mock: !status.isLive,
  };

  for (const kw of tracked) {
    let snapshot;
    try {
      snapshot = await provider.serpResults({ keyword: kw.phrase, depth: 20 });
    } catch (err) {
      // One keyword's failure must not kill the whole batch — record the
      // keyword as skipped and keep going.
      result.skipped += 1;
      console.error(`Rank check failed for "${kw.phrase}":`, err);
      continue;
    }

    const match = snapshot.results.find((r) =>
      domainMatches(r.domain, project.domain),
    );
    const position = match ? match.position : null;
    const url = match ? match.url : null;

    // Previous check = latest Ranking row strictly before this batch.
    const previous = await prisma.ranking.findFirst({
      where: { keywordId: kw.id, checkedAt: { lt: now } },
      orderBy: { checkedAt: "desc" },
    });

    await prisma.ranking.create({
      data: {
        keywordId: kw.id,
        checkedAt: now,
        position,
        url,
        aiOverviewPresent: snapshot.aiOverviewPresent ?? false,
      },
    });

    result.alerts.push(
      ...computeAlerts(kw.id, kw.phrase, previous?.position ?? null, position, now),
    );
    result.rankings.push({ keywordId: kw.id, phrase: kw.phrase, position, url });
    result.checked += 1;

    await recordUsage(project.workspaceId, "serp_calls", 1).catch(() => {});
  }

  return result;
}

export async function POST(req: NextRequest) {
  const isCron = cronAuthorized(req);
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { projectId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const projectId = String(body.projectId ?? "").trim();
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  if (projectId === "all") {
    if (!isCron) {
      return Response.json(
        { error: '"all" requires the cron secret' },
        { status: 403 },
      );
    }
    const projects = await prisma.project.findMany({ select: { id: true } });
    const results = [];
    for (const p of projects) {
      results.push(await checkProject(p.id));
    }
    return Response.json({ ok: true, projects: results });
  }

  if (!isCron) {
    const owned = await prisma.project.findFirst({
      where: { id: projectId, workspace: accessibleWorkspaceWhere(user!.id) },
      select: { id: true },
    });
    if (!owned) {
      return Response.json({ error: "Project not found" }, { status: 404 });
    }
    // Milestone 11: session-triggered rank checks are editor+ (they spend
    // DataForSEO credits). The CRON_SECRET path is a service actor.
    if (!(await requireProjectRole(user!.id, projectId, "editor"))) return forbidden();
  }

  const result = await checkProject(projectId);
  return Response.json({ ok: true, ...result });
}

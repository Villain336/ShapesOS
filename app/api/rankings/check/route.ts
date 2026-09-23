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
import { providerStatus } from "@/lib/providers";
import { pullSerp } from "@/lib/serp/pull";
import { recordUsage } from "@/lib/usage";
import { meter } from "@/lib/metering/service";
import { domainMatches, computeAlerts, type RankAlert } from "@/lib/rankings";
import { emitAlert, type TriggerInput } from "@/lib/alerts/evaluate";
import { recordSnapshot } from "@/lib/retention/ai-visibility";

export const dynamic = "force-dynamic";

interface CheckResult {
  projectId: string;
  domain: string;
  checked: number;
  skipped: number;
  /** Keywords whose ledger charge was denied by the spend cap. */
  meteringBlocked: number;
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

  const status = providerStatus();
  const now = new Date();
  const result: CheckResult = {
    projectId,
    domain: project.domain,
    checked: 0,
    skipped: 0,
    meteringBlocked: 0,
    rankings: [],
    alerts: [],
    mock: !status.isLive,
  };

  for (const kw of tracked) {
    let snapshot;
    try {
      // Internal SERP pull via the shared un-metered helper (T14): the
      // rank check charges "rank_check" per ranking row below — never
      // "serp_analysis" for these pulls.
      snapshot = (await pullSerp({ keyword: kw.phrase, depth: 20 })).snapshot;
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

    const ranking = await prisma.ranking.create({
      data: {
        keywordId: kw.id,
        checkedAt: now,
        position,
        url,
        aiOverviewPresent: snapshot.aiOverviewPresent ?? false,
      },
    });

    // Phase C gaps (G1): ledger one rank_check per keyword. The ranking row
    // is the domain row — the idempotency key makes retried batches charge
    // exactly once per check. workspaceId comes from the project row (server
    // context), never the request body (T10).
    const mres = await meter({
      workspaceId: project.workspaceId,
      projectId,
      action: "rank_check",
      idempotencyKey: `rankcheck:${ranking.id}`,
      evidenceRef: `rank-check:${ranking.id}`,
    }).catch((err) => {
      console.error(`Metering failed for rank check ${ranking.id}:`, err);
      return null;
    });
    if (mres && !mres.ok) result.meteringBlocked += 1;

    const newAlerts = computeAlerts(kw.id, kw.phrase, previous?.position ?? null, position, now);
    result.alerts.push(...newAlerts);

    // Milestone 14: record an AI visibility snapshot (presence + citation)
    // for every check. Snapshot failures must never break rank checks.
    let aiChanges = { appeared: false, disappeared: false, citationGained: false, citationLost: false };
    try {
      const snap = await recordSnapshot({
        projectId,
        keywordId: kw.id,
        snapshot,
        projectDomain: project.domain,
        checkedAt: now,
        mock: result.mock,
      });
      aiChanges = snap.changes;
    } catch (err) {
      console.error(`AI snapshot failed for "${kw.phrase}":`, err);
    }

    // Milestone 13: fan rank movements + AI Overview changes into the alert hub.
    // Evaluation is best-effort — alert failures must never break rank checks.
    const dayKey = now.toISOString().slice(0, 10);
    const triggers: TriggerInput[] = [];
    for (const a of newAlerts) {
      const base = {
        workspaceId: project.workspaceId,
        projectId,
        link: `/dashboard/projects/${projectId}/rankings`,
        scopeKeywordIds: [kw.id],
      };
      if (a.kind === "big_loss" || a.kind === "dropped_out" || a.kind === "left_top_10") {
        const movement = a.kind === "dropped_out" ? 100 : a.kind === "left_top_10" ? 10 : (a.from ?? 0) - (a.to ?? 0);
        triggers.push({
          ...base,
          trigger: "rank_drop",
          severity: a.kind === "dropped_out" ? "critical" : "warn",
          title: `🔻 "${kw.phrase}" dropped ${movement} positions (${a.from ?? "–"} → ${a.to ?? "–"})`,
          body: `"${kw.phrase}" on ${project.domain} moved from #${a.from ?? "unranked"} to #${a.to ?? "unranked"}.`,
          movement,
          dedupKey: `rank_drop:${kw.id}:${dayKey}`,
        });
      } else {
        const movement = a.kind === "newly_ranking" ? 5 : a.kind === "entered_top_10" ? 10 : (a.from ?? 0) - (a.to ?? 0);
        triggers.push({
          ...base,
          trigger: "rank_gain",
          severity: "info" as const,
          title: `📈 "${kw.phrase}" gained ${movement} positions (${a.from ?? "–"} → ${a.to ?? "–"})`,
          body: `"${kw.phrase}" on ${project.domain} moved from #${a.from ?? "unranked"} to #${a.to ?? "unranked"}.`,
          movement,
          dedupKey: `rank_gain:${kw.id}:${dayKey}`,
        });
      }
    }
    const aiNow = snapshot.aiOverviewPresent ?? false;
    if (previous && previous.aiOverviewPresent !== aiNow) {
      triggers.push({
        workspaceId: project.workspaceId,
        projectId,
        trigger: "ai_overview_change",
        severity: "info" as const,
        title: aiNow
          ? `AI Overviews now appearing for "${kw.phrase}"`
          : `AI Overviews no longer appearing for "${kw.phrase}"`,
        body: `Google AI Overview presence for "${kw.phrase}" changed to ${aiNow ? "present" : "absent"} on the latest SERP check.`,
        link: `/dashboard/projects/${projectId}/ai-search`,
        scopeKeywordIds: [kw.id],
        dedupKey: `ai_overview:${kw.id}:${dayKey}`,
      });
    }
    // Milestone 14: citation changes inside the AI answer get their own
    // trigger so agencies can route citation wins/losses separately.
    if (aiChanges.citationGained || aiChanges.citationLost) {
      triggers.push({
        workspaceId: project.workspaceId,
        projectId,
        trigger: "ai_citation_change",
        severity: (aiChanges.citationGained ? "info" : "warn") as "info" | "warn",
        title: aiChanges.citationGained
          ? `"${kw.phrase}" — your site is now cited in the AI answer`
          : `⚠️ "${kw.phrase}" — your site lost its AI answer citation`,
        body: aiChanges.citationGained
          ? `${project.domain} is now cited inside the AI answer for "${kw.phrase}".`
          : `${project.domain} is no longer cited inside the AI answer for "${kw.phrase}".`,
        link: `/dashboard/projects/${projectId}/ai-search`,
        scopeKeywordIds: [kw.id],
        dedupKey: `ai_citation:${kw.id}:${dayKey}`,
      });
    }
    if (triggers.length) {
      await Promise.allSettled(triggers.map((t) => emitAlert(t)));
    }
    result.rankings.push({ keywordId: kw.id, phrase: kw.phrase, position, url });
    result.checked += 1;

    await recordUsage(project.workspaceId, "serp_calls", 1).catch(() => {});
  }

  // Milestone 11/14 audit pattern: one workspace-scoped event per check run
  // covering the AI visibility snapshots recorded alongside the rankings.
  await prisma.fileChangeLog
    .create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        connectionId: null,
        filePath: "",
        actor: "system",
        action: "ai_visibility_snapshot",
        summary: `Rank check: ${result.checked} keyword(s) checked, AI visibility snapshots recorded for ${project.domain}`,
      },
    })
    .catch(() => {});

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

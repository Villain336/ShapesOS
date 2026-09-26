// Marketr — Phase 10 M1: rank intelligence API.
// GET /api/intelligence/rank?projectId=&preStart=&preEnd=&postStart=&postEnd=
//   → GSC connection status, BigQuery export status, GSC deltas,
//     recomputed visibility (winners/losers + score), rows badged by source.
//
// Owned keywords resolve from GSC; residual rows (competitor /
// zero-impression / SERP-feature) are badged "paid" and resolve through the
// live M6 fetchSerp contract when a SERP vendor is configured.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import {
  computeDeltas,
  recomputeGscVisibility,
  getBigQueryExportStatus,
  getGscToken,
  type RankTableRow,
} from "@/lib/intelligence/gsc";
import { vendorHealth } from "@/lib/intelligence/providers";

export const dynamic = "force-dynamic";

function parseDate(v: string | null, fallback: Date): Date {
  if (!v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return Response.json({ error: "projectId is required" }, { status: 400 });
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId: workspace.id },
    select: { id: true, domain: true },
  });
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  const now = new Date();
  const postEnd = parseDate(req.nextUrl.searchParams.get("postEnd"), now);
  const postStart = parseDate(
    req.nextUrl.searchParams.get("postStart"),
    new Date(postEnd.getTime() - 7 * 24 * 60 * 60 * 1000),
  );
  const preEnd = parseDate(req.nextUrl.searchParams.get("preEnd"), postStart);
  const preStart = parseDate(
    req.nextUrl.searchParams.get("preStart"),
    new Date(preEnd.getTime() - 7 * 24 * 60 * 60 * 1000),
  );

  // GSC connection status (reuses the M21 vault — never throws to the UI).
  let gscConnected = false;
  let gscProperty: string | null = null;
  try {
    const token = await getGscToken(workspace.id, project.id);
    gscConnected = true;
    gscProperty = token.property;
  } catch {
    gscConnected = false;
  }

  const bigquery = await getBigQueryExportStatus(workspace.id);

  let deltas: Awaited<ReturnType<typeof computeDeltas>> = [];
  let visibility: Awaited<ReturnType<typeof recomputeGscVisibility>> | null = null;
  let visibilityError: string | null = null;
  if (gscConnected) {
    try {
      visibility = await recomputeGscVisibility(
        workspace.id,
        project.id,
        { start: preStart, end: preEnd },
        { start: postStart, end: postEnd },
      );
      deltas = visibility.deltas;
    } catch (e) {
      visibilityError = (e as Error).message.slice(0, 200);
    }
  }

  // Rows badged by source: GSC deltas are "gsc". Paid residual rows go
  // through the real M6 fetchSerp contract — available whenever at least
  // one SERP vendor is configured (fetchSerp throws VendorNotConfigured
  // otherwise, never a crash). Owned keywords still resolve from GSC and
  // never spend a call.
  const rows: RankTableRow[] = deltas.map((d) => ({
    ...d,
    source: "gsc" as const,
    postPosition: null,
    prePosition: null,
  }));

  let paidAvailable = false;
  let paidReason = "No SERP vendor configured — set one up to enable residual checks";
  try {
    const health = await vendorHealth(workspace.id);
    paidAvailable = health.some((h) => h.configured);
  } catch {
    paidAvailable = false;
    paidReason = "Vendor health check failed";
  }

  return Response.json({
    project: { id: project.id, domain: project.domain },
    windows: {
      pre: { start: preStart.toISOString(), end: preEnd.toISOString() },
      post: { start: postStart.toISOString(), end: postEnd.toISOString() },
    },
    gsc: { connected: gscConnected, property: gscProperty },
    bigquery,
    visibility: visibility
      ? {
          scorePre: visibility.scorePre,
          scorePost: visibility.scorePost,
          scoreDelta: visibility.scoreDelta,
          winners: visibility.winnersLosers.winners,
          losers: visibility.winnersLosers.losers,
          improvedCount: visibility.winnersLosers.improvedCount,
          declinedCount: visibility.winnersLosers.declinedCount,
        }
      : null,
    visibilityError,
    rows,
    paidResidual: { available: paidAvailable, reason: paidAvailable ? "M6 fetchSerp contract — competitor keywords, zero-impression queries, SERP-feature composition" : paidReason },
  });
}

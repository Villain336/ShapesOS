// Marketr — per-site fix-agent settings (milestone 10).
// GET /api/websites/[id]/fix-agent?projectId=… → settings
// PUT /api/websites/[id]/fix-agent { projectId, enabled, allowedCategories, maxFixesPerRun, dryRun }

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { ownedSite } from "@/lib/connectors/source";
import { prisma } from "@/lib/prisma";
import { CATEGORY_MAP, DEFAULT_ALLOWED_CATEGORIES } from "@/lib/audit/categories";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const site = await ownedSite(user.id, projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const settings = await prisma.fixAgentSettings.upsert({
    where: { siteId: site.id },
    update: {},
    create: { siteId: site.id, allowedCategories: DEFAULT_ALLOWED_CATEGORIES },
  });
  return Response.json({ ok: true, settings });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readJsonBody<{
    projectId?: string;
    enabled?: boolean;
    allowedCategories?: string[];
    maxFixesPerRun?: number;
    dryRun?: boolean;
  }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const allowed = (body?.allowedCategories ?? []).filter((c) => CATEGORY_MAP[c]);
  const maxFixes = Math.min(50, Math.max(1, Math.floor(body?.maxFixesPerRun ?? 10)));

  const settings = await prisma.fixAgentSettings.upsert({
    where: { siteId: site.id },
    update: {
      enabled: body?.enabled === true,
      allowedCategories: allowed,
      maxFixesPerRun: maxFixes,
      dryRun: body?.dryRun !== false,
    },
    create: {
      siteId: site.id,
      enabled: body?.enabled === true,
      allowedCategories: allowed.length ? allowed : DEFAULT_ALLOWED_CATEGORIES,
      maxFixesPerRun: maxFixes,
      dryRun: body?.dryRun !== false,
    },
  });
  return Response.json({ ok: true, settings });
}

// Marketr — workspace backlinks spend cap (milestone 15).
// GET /api/workspace/spend-cap → { capUsd, custom, usedUsd, defaultCapUsd } (viewer+).
// PUT /api/workspace/spend-cap { capUsd } (admin+; money-adjacent config,
// same bar as alert-channel writes in milestone 13). Set capUsd to null to
// revert to the default guardrail.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { monthlyBacklinkSpendUsd } from "@/lib/seo/backlink-pull";
import { DEFAULT_MONTHLY_SPEND_CAP_USD } from "@/lib/seo/backlinks-cost";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const usedUsd = await monthlyBacklinkSpendUsd(workspace.id);
  return Response.json({
    capUsd: workspace.backlinksSpendCapUsd ?? DEFAULT_MONTHLY_SPEND_CAP_USD,
    custom: workspace.backlinksSpendCapUsd != null,
    usedUsd,
    defaultCapUsd: DEFAULT_MONTHLY_SPEND_CAP_USD,
  });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  let body: { capUsd?: number | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let capUsd: number | null = null;
  if (body.capUsd !== undefined && body.capUsd !== null) {
    if (typeof body.capUsd !== "number" || !Number.isFinite(body.capUsd) || body.capUsd < 0) {
      return Response.json({ error: "capUsd must be a non-negative number or null" }, { status: 400 });
    }
    capUsd = Math.round(body.capUsd * 100) / 100;
  }

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { backlinksSpendCapUsd: capUsd },
  });
  return Response.json({
    capUsd: capUsd ?? DEFAULT_MONTHLY_SPEND_CAP_USD,
    custom: capUsd != null,
    defaultCapUsd: DEFAULT_MONTHLY_SPEND_CAP_USD,
  });
}

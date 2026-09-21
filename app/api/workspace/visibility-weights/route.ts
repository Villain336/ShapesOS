// Marketr — visibility score weights config (milestone 14).
// GET /api/workspace/visibility-weights → { weights } (viewer+).
// PUT /api/workspace/visibility-weights { weights } (admin+; credentials-adjacent
// config, same bar as alert-channel writes in milestone 13).

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { DEFAULT_WEIGHTS, resolveWeights } from "@/lib/retention/visibility-score";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();
  return Response.json({ weights: resolveWeights(workspace.visibilityWeights), defaults: DEFAULT_WEIGHTS });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  let body: { weights?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const weights = resolveWeights(body.weights);
  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { visibilityWeights: weights as unknown as object },
  });
  return Response.json({ weights });
}

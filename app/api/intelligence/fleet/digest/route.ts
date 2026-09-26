// Marketr — Phase 10 M4: weekly digest API (on-demand build).
// GET /api/intelligence/fleet/digest?projectId=
//
// Builds the same digest object the weekly cron produces (last 7 days).
// projectId is accepted for UI scoping but the digest aggregates at the
// workspace level (watches are per-project; the digest rolls them up).

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireProjectRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { buildWeeklyDigest } from "@/lib/intelligence/fleet/digest";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  if (projectId && !(await requireProjectRole(user.id, projectId, "viewer"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
  try {
    const digest = await withWorkspaceScope(workspaceId, (tx) =>
      buildWeeklyDigest(tx, workspaceId),
    );
    return Response.json({ digest });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "digest failed" },
      { status: 500 },
    );
  }
}

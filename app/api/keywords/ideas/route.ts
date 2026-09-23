// Marketr — keyword research API (spec §5 flow 1).
// POST /api/keywords/ideas  { projectId, seed, limit? } → { ideas, provider }
// Ideas come from the swappable SeoDataProvider (DataForSEO live when
// credentials are configured, clearly-marked mock otherwise).
// Each research call increments the serp_calls meter (best-effort).

import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import { recordUsage } from "@/lib/usage";
import { meter } from "@/lib/metering/service";
import { hourBucket, seedHash } from "@/lib/metering/wiring";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: { projectId?: string; seed?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const seed = String(body.seed ?? "").trim();
  if (!seed) {
    return Response.json({ error: "seed is required" }, { status: 400 });
  }

  const project = await prisma.project.findFirst({
    where: { id: body.projectId, workspace: accessibleWorkspaceWhere(user.id) },
    include: { workspace: true },
  });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }
  if (!(await requireProjectRole(user.id, body.projectId, "editor"))) return forbidden();

  const provider = getSeoProvider();
  const limit = Math.max(1, Math.min(body.limit ?? 50, 200));

  try {
    const ideas = await provider.keywordIdeas({ seed, limit });
    // Phase C gaps (G1): ledger the expansion. No domain row exists for an
    // ideas call, so the idempotency key is hour-bucketed (T12): retries and
    // double-clicks within the hour dedup; genuinely repeated use later
    // charges again.
    await meter({
      workspaceId: project.workspaceId,
      projectId: project.id,
      action: "keyword_ideas",
      idempotencyKey: `kwideas:${project.id}:${seedHash(seed.toLowerCase())}:${limit}:${hourBucket()}`,
      evidenceRef: `keyword-ideas:${seed.slice(0, 60)}`,
    }).catch(() => {});
    await recordUsage(project.workspaceId, "serp_calls", 1).catch(() => {});
    return Response.json({ ideas, provider: providerStatus() });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Keyword research failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

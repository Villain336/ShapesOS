// Marketr — Platform-change radar: event detail.
// GET /api/intelligence/radar/event/[id] — event + per-page impacts + volatility.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { readImpacts } from "@/lib/intelligence/radar/correlate";
import { getVolatilityReadings } from "@/lib/intelligence/radar/volatility";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email ?? "");
  const { id } = await params;

  const event = await withWorkspaceScope(workspace.id, async (tx) =>
    tx.platformEvent.findUnique({
      where: { id },
      include: { _count: { select: { pageImpacts: true } } },
    }),
  );
  if (!event) return Response.json({ error: "Not found" }, { status: 404 });

  const impacts = await readImpacts(workspace.id, id);
  const volatility = await getVolatilityReadings();

  return Response.json({
    event: {
      id: event.id,
      source: event.source,
      eventType: event.eventType,
      title: event.title,
      startedAt: event.startedAt?.toISOString() ?? null,
      endedAt: event.endedAt?.toISOString() ?? null,
      url: event.url,
      classificationConfidence: event.classificationConfidence,
    },
    impacts: impacts.map((i) => {
      const band = (i.confidenceBand as [number, number] | null) ?? null;
      return {
        projectId: i.projectId,
        domain: i.project?.domain ?? null,
        page: i.page,
        query: i.query,
        deltaClicks: i.deltaClicks,
        deltaImpressions: i.deltaImpressions,
        impactScore: i.impactScore,
        confidenceBand: band,
      };
    }),
    volatility,
  });
}

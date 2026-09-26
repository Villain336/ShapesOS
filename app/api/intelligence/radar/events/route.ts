// Marketr — Platform-change radar: event list.
// GET /api/intelligence/radar/events?type=rollout&source=status_dashboard&q=&limit=

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { listEvents } from "@/lib/intelligence/radar/ingest";
import type { PlatformEventSource, PlatformEventType } from "@prisma/client";

const TYPES: PlatformEventType[] = ["rollout", "docs_change", "volatility"];
const SOURCES: PlatformEventSource[] = ["status_dashboard", "search_central", "bing_blog"];

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email ?? "");

  const sp = new URL(req.url).searchParams;
  const typeParam = sp.get("type");
  const sourceParam = sp.get("source");
  const q = (sp.get("q") ?? "").trim().toLowerCase();
  const type = TYPES.includes(typeParam as PlatformEventType)
    ? (typeParam as PlatformEventType)
    : undefined;
  const source = SOURCES.includes(sourceParam as PlatformEventSource)
    ? (sourceParam as PlatformEventSource)
    : undefined;

  const events = await listEvents(workspace.id, { type, source, limit: 200 });
  const filtered = q
    ? events.filter((e) => e.title.toLowerCase().includes(q))
    : events;

  return Response.json({
    events: filtered.map((e) => ({
      id: e.id,
      source: e.source,
      eventType: e.eventType,
      title: e.title,
      startedAt: e.startedAt?.toISOString() ?? null,
      endedAt: e.endedAt?.toISOString() ?? null,
      url: e.url,
      classificationConfidence: e.classificationConfidence,
      impactedCount: e._count.pageImpacts,
    })),
  });
}

// ShapesOS — Phase 18.3 (WS=trust): timeline filters from a query string (pure).

import { ACTOR_KINDS, isTimelineSource, type ActorKind, type TimelineFilter, type TimelineSource } from "./normalize";

function date(v: string | null, endOfDay = false): Date | null {
  if (!v) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function filterFromQuery(q: URLSearchParams): TimelineFilter {
  const actor = q.get("actor");
  const sources = (q.get("source") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isTimelineSource) as TimelineSource[];
  return {
    actorKind: actor && (ACTOR_KINDS as readonly string[]).includes(actor) ? (actor as ActorKind) : null,
    sources: sources.length ? sources : null,
    from: date(q.get("from")),
    to: date(q.get("to"), true),
  };
}

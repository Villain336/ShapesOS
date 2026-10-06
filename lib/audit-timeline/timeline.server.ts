// ShapesOS — Phase 18.3 (WS=trust): one audit timeline across every trail.
//
//   loadTimeline(ws, filter, cursor, limit)   one page, newest first
//   timelineCsv(ws, filter)                    the same rows as CSV (capped)
//
// Admin+ only (the routes and the page check it). Each adapter reads its own
// table for THIS workspace; the pages are merged by (time, key) and the
// cursor is the last row's (time, key), so paging is stable across sources.
// Person actors are shown by their member name or email in this workspace.

import { prisma } from "@/lib/prisma";
import { TIMELINE_ADAPTERS, type TimelineAdapter } from "./sources.server";
import {
  CSV_HEADER,
  csvRow,
  decodeCursor,
  mergePages,
  type TimelineEntry,
  type TimelineFilter,
} from "./normalize";

export const TIMELINE_PAGE = 50;
export const TIMELINE_CSV_MAX = 5000;

/** Adapters this filter can possibly match (a person filter skips agent-only sources). */
export function adaptersFor(filter: TimelineFilter, adapters: readonly TimelineAdapter[] = TIMELINE_ADAPTERS): TimelineAdapter[] {
  return adapters.filter((a) => {
    if (filter.sources?.length && !filter.sources.includes(a.source)) return false;
    if (filter.actorKind && a.onlyActor && a.onlyActor !== filter.actorKind) return false;
    return true;
  });
}

/** Member names for person actors (this workspace only). */
export async function resolveActorLabels(workspaceId: string, entries: TimelineEntry[]): Promise<void> {
  const ids = [...new Set(entries.filter((e) => e.actor.kind === "person" && e.actor.id).map((e) => e.actor.id!))];
  if (!ids.length) return;
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, userId: { in: ids } },
    select: { userId: true, name: true, email: true },
  });
  const byId = new Map(members.map((m) => [m.userId!, m.name?.trim() || m.email || "Member"]));
  for (const e of entries) {
    if (e.actor.kind === "person" && e.actor.id && byId.has(e.actor.id)) e.actor.label = byId.get(e.actor.id)!;
  }
}

export interface TimelinePage {
  entries: TimelineEntry[];
  next: string | null;
  /** Sources that failed to load (the rest still render). */
  errors: Array<{ source: string; message: string }>;
}

export async function loadTimeline(
  workspaceId: string,
  filter: TimelineFilter = {},
  cursorText: string | null = null,
  limit: number = TIMELINE_PAGE,
  adapters: readonly TimelineAdapter[] = TIMELINE_ADAPTERS,
): Promise<TimelinePage> {
  const take = Math.min(Math.max(limit, 1), 200);
  const cursor = decodeCursor(cursorText);
  const before = cursor ? new Date(cursor.at) : filter.to ?? null;
  const errors: TimelinePage["errors"] = [];
  // Fetch a little past the page: rows that tie on the cursor time are
  // filtered after the merge, and a filter can drop some.
  const perSource = take + 25;
  const pages = await Promise.all(
    adaptersFor(filter, adapters).map(async (a) => {
      try {
        return await a.load({ workspaceId, before, from: filter.from ?? null, take: perSource });
      } catch (err) {
        errors.push({ source: a.source, message: err instanceof Error ? err.message.slice(0, 200) : "error" });
        return [];
      }
    }),
  );
  const page = mergePages(pages, cursor, take, filter);
  await resolveActorLabels(workspaceId, page.entries);
  return { ...page, errors };
}

/** The filtered timeline as CSV text (newest first, at most TIMELINE_CSV_MAX rows). */
export async function timelineCsv(workspaceId: string, filter: TimelineFilter = {}): Promise<{ csv: string; rows: number }> {
  const lines = [CSV_HEADER];
  let cursor: string | null = null;
  let rows = 0;
  while (rows < TIMELINE_CSV_MAX) {
    const page = await loadTimeline(workspaceId, filter, cursor, 200);
    for (const e of page.entries) lines.push(csvRow(e));
    rows += page.entries.length;
    if (!page.next || page.entries.length === 0) break;
    cursor = page.next;
  }
  return { csv: lines.join("\n"), rows };
}

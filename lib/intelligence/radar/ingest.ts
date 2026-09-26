// Marketr — Phase 10 M2: official-source ingestion.
//
// SOURCES (SPEC-PHASE10.md §2 — clean list):
//   1. Google Search Status Dashboard — https://status.search.google.com/incidents.json
//      (machine-readable JSON of every confirmed ranking incident; verified live
//      2026-09-26 from this build box). Only the 10 most recent rows are served,
//      so the cron upserts daily and dedups by incident id.
//   2. Google Search Central docs changelog RSS —
//      https://developers.google.com/search/updates/search_docs_updates.rss
//      (the feed URL Google itself publishes on the changelog page).
//   3. Bing Webmaster blog RSS — https://blogs.bing.com/webmaster/feed/
//      (needs a browser UA / redirect follow; graceful when unreachable).
//
// HARD LINE: no SEO-Twitter, no practitioner blogs, no rumor scraping — ever.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type { PlatformEventSource, PlatformEventType } from "@prisma/client";
import type { ClassifiedEvent, PreparedEvent, RadarSource, RawSourceItem } from "./types";

const UA = "Marketr-PlatformRadar/1.0 (+https://marketr.launchabl.com; official-sources-only)";
const FETCH_TIMEOUT_MS = 20_000;

export const SOURCE_ENDPOINTS: Record<RadarSource, string> = {
  status_dashboard: "https://status.search.google.com/incidents.json",
  search_central: "https://developers.google.com/search/updates/search_docs_updates.rss",
  bing_blog: "https://blogs.bing.com/webmaster/feed/",
};

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "application/json, application/rss+xml, application/xml, text/xml, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(s: string): string {
  // Unescape entities FIRST (feeds HTML-escape their markup), then strip tags.
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Minimal RSS 2.0 item parser (no deps; feeds are small and stable). */
export function parseRssItems(xml: string): Array<{
  guid: string;
  title: string;
  link: string | null;
  pubDate: string | null;
  description: string;
}> {
  const items: Array<{
    guid: string;
    title: string;
    link: string | null;
    pubDate: string | null;
    description: string;
  }> = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const tag = (body: string, name: string): string | null => {
    const m = body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    return m ? m[1].trim() : null;
  };
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const body = m[1];
    const title = tag(body, "title");
    if (!title) continue;
    const guid = tag(body, "guid") ?? tag(body, "link") ?? title;
    items.push({
      guid: stripHtml(guid),
      title: stripHtml(title),
      link: tag(body, "link"),
      pubDate: tag(body, "pubDate") ?? tag(body, "dc:date"),
      description: stripHtml(tag(body, "description") ?? ""),
    });
  }
  return items;
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- Source fetchers --------------------------------------------------------

interface IncidentJson {
  id: string;
  external_desc?: string;
  begin?: string;
  end?: string;
  uri?: string;
  service_name?: string;
}

/** incidents.json → RawSourceItem[] (confirmed ranking incidents only). */
export function normalizeStatusDashboard(body: string): RawSourceItem[] {
  let parsed: IncidentJson[];
  try {
    parsed = JSON.parse(body) as IncidentJson[];
  } catch {
    throw new Error("status dashboard incidents.json is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("status dashboard incidents.json: expected an array");
  return parsed
    .filter((i) => i && typeof i.id === "string")
    .map((i) => {
      const summaryBits = [
        i.external_desc ?? "",
        i.service_name ? `Service: ${i.service_name}` : "",
      ].filter(Boolean);
      return {
        externalId: i.id,
        source: "status_dashboard" as RadarSource,
        title: stripHtml(i.external_desc ?? "(untitled incident)"),
        summary: stripHtml(summaryBits.join(" — ")),
        startedAt: parseDate(i.begin ?? null),
        endedAt: parseDate(i.end ?? null),
        url: i.uri ? `https://status.search.google.com/${i.uri}` : null,
      };
    });
}

export async function fetchStatusDashboard(): Promise<RawSourceItem[]> {
  return normalizeStatusDashboard(await fetchText(SOURCE_ENDPOINTS.status_dashboard));
}

function rssToItems(source: RadarSource, xml: string): RawSourceItem[] {
  return parseRssItems(xml).map((it) => ({
    externalId: it.guid,
    source,
    title: it.title,
    summary: it.description,
    startedAt: parseDate(it.pubDate),
    endedAt: null,
    url: it.link,
  }));
}

export async function fetchSearchCentralDocs(): Promise<RawSourceItem[]> {
  return rssToItems("search_central", await fetchText(SOURCE_ENDPOINTS.search_central));
}

export async function fetchBingBlog(): Promise<RawSourceItem[]> {
  return rssToItems("bing_blog", await fetchText(SOURCE_ENDPOINTS.bing_blog));
}

/** Fetch all official sources; one source failing never fails the run. */
export async function fetchAllSources(): Promise<{
  items: RawSourceItem[];
  errors: string[];
}> {
  const items: RawSourceItem[] = [];
  const errors: string[] = [];
  const jobs: Array<[RadarSource, () => Promise<RawSourceItem[]>]> = [
    ["status_dashboard", fetchStatusDashboard],
    ["search_central", fetchSearchCentralDocs],
    ["bing_blog", fetchBingBlog],
  ];
  for (const [source, fn] of jobs) {
    try {
      const got = await fn();
      items.push(...got);
    } catch (err) {
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { items, errors };
}

// --- Persistence ------------------------------------------------------------

export interface UpsertStats {
  created: number;
  updated: number;
  skipped: number;
}

const CLASSIFIED_TO_PRISMA: Record<PreparedEvent["classification"]["eventType"], PlatformEventType> = {
  rollout: "rollout",
  docs_change: "docs_change",
  volatility: "volatility",
};

const SOURCE_TO_PRISMA: Record<RadarSource, PlatformEventSource> = {
  status_dashboard: "status_dashboard",
  search_central: "search_central",
  bing_blog: "bing_blog",
};

/**
 * Upsert classified events into platform_event, scoped to the workspace
 * (FORCE RLS, fail-closed). Dedup key: (source, url) when a url exists,
 * otherwise (source, title, startedAt ±12h).
 */
export async function upsertEvents(
  workspaceId: string,
  events: PreparedEvent[],
): Promise<UpsertStats & { rows: Array<{ id: string; type: PlatformEventType }> }> {
  const stats: UpsertStats = { created: 0, updated: 0, skipped: 0 };
  const rows: Array<{ id: string; type: PlatformEventType }> = [];
  await withWorkspaceScope(workspaceId, async (tx) => {
    for (const ev of events) {
      const source = SOURCE_TO_PRISMA[ev.source];
      const eventType = CLASSIFIED_TO_PRISMA[ev.classification.eventType];
      let existing: { id: string; eventType: PlatformEventType } | null = null;
      if (ev.url) {
        existing = await tx.platformEvent.findFirst({
          where: { source, url: ev.url },
          select: { id: true, eventType: true },
        });
      }
      if (!existing) {
        const lo = ev.startedAt ? new Date(ev.startedAt.getTime() - 12 * 3600_000) : null;
        const hi = ev.startedAt ? new Date(ev.startedAt.getTime() + 12 * 3600_000) : null;
        existing = await tx.platformEvent.findFirst({
          where: {
            source,
            title: ev.title,
            ...(lo && hi ? { startedAt: { gte: lo, lte: hi } } : {}),
          },
          select: { id: true, eventType: true },
        });
      }
      if (existing) {
        // Never downgrade a human- or LLM-confirmed rollout to docs_change on
        // re-ingest; refresh timestamps + confidence only.
        await tx.platformEvent.update({
          where: { id: existing.id },
          data: {
            startedAt: ev.startedAt ?? undefined,
            endedAt: ev.endedAt ?? undefined,
            classificationConfidence: ev.classification.confidence,
          },
        });
        stats.updated += 1;
        rows.push({ id: existing.id, type: existing.eventType });
      } else {
        const created = await tx.platformEvent.create({
          data: {
            workspaceId,
            source,
            eventType,
            title: ev.title.slice(0, 500),
            startedAt: ev.startedAt,
            endedAt: ev.endedAt,
            url: ev.url?.slice(0, 2000) ?? null,
            classificationConfidence: ev.classification.confidence,
          },
          select: { id: true, eventType: true },
        });
        stats.created += 1;
        rows.push({ id: created.id, type: created.eventType });
      }
    }
  });
  return { ...stats, rows };
}

/** Read the most recent events for the workspace (UI + alerts). */
export async function listEvents(
  workspaceId: string,
  opts: { type?: PlatformEventType; source?: PlatformEventSource; limit?: number } = {},
) {
  return withWorkspaceScope(workspaceId, async (tx) =>
    tx.platformEvent.findMany({
      where: {
        ...(opts.type ? { eventType: opts.type } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }],
      take: Math.min(opts.limit ?? 100, 500),
      include: {
        _count: { select: { pageImpacts: true } },
      },
    }),
  );
}

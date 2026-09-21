// Marketr — competitor radar (milestone 14).
//
// Weekly scheduled diff of consecutive competitor keyword snapshots
// (milestone 3's gap analysis, persisted). Detects four event types:
//   - new_keyword: competitor now ranks (top 50) for a keyword it didn't
//     before, with meaningful volume — new battleground.
//   - keyword_gain: competitor climbed ≥10 positions into the top 20 on a
//     keyword it already ranked for.
//   - new_page: a competitor URL never seen before now ranks for ≥2
//     keywords — likely a new page or content push.
//   - lost_to_competitor: head-to-head loss on one of OUR tracked keywords —
//     the competitor now outranks our domain where it didn't before.
//
// Snapshots come from the existing SEO provider's competitorKeywords()
// (DataForSEO Labs ranked_keywords when live); the diff itself is pure and
// unit-testable. No new paid APIs.

import { prisma } from "@/lib/prisma";
import { normalizePhrase } from "@/lib/competitors";

export type RadarEventType = "new_keyword" | "keyword_gain" | "new_page" | "lost_to_competitor";

export interface SnapshotKeyword {
  phrase: string;
  position: number | null;
  url: string | null;
  volume: number | null;
}

/** Our side of a head-to-head: latest + previous position for a tracked keyword. */
export interface OurTrackedPosition {
  phrase: string;
  current: number | null;
  previous: number | null;
}

export interface RadarEvent {
  eventType: RadarEventType;
  keywordPhrase: string | null;
  details: Record<string, unknown>;
}

const SNAPSHOT_LIMIT = 50;
const NEW_KEYWORD_MIN_VOLUME = 200;
const GAIN_THRESHOLD = 10;
const GAIN_MAX_POSITION = 20;

/** Pure snapshot diff (unit-testable). */
export function diffCompetitorSnapshots(
  previous: SnapshotKeyword[] | null,
  latest: SnapshotKeyword[],
  ourTracked: OurTrackedPosition[],
): RadarEvent[] {
  const events: RadarEvent[] = [];
  const prevByPhrase = new Map<string, SnapshotKeyword>();
  for (const k of previous ?? []) prevByPhrase.set(normalizePhrase(k.phrase), k);
  const prevUrls = new Set((previous ?? []).map((k) => k.url).filter((u): u is string => !!u));

  // --- new_keyword / keyword_gain ---
  for (const k of latest.slice(0, SNAPSHOT_LIMIT)) {
    if (k.position == null || k.position > SNAPSHOT_LIMIT) continue;
    const key = normalizePhrase(k.phrase);
    const prev = prevByPhrase.get(key);
    if (!prev || prev.position == null) {
      if ((k.volume ?? 0) >= NEW_KEYWORD_MIN_VOLUME) {
        events.push({
          eventType: "new_keyword",
          keywordPhrase: k.phrase,
          details: { position: k.position, volume: k.volume, url: k.url },
        });
      }
    } else if (prev.position - k.position >= GAIN_THRESHOLD && k.position <= GAIN_MAX_POSITION) {
      events.push({
        eventType: "keyword_gain",
        keywordPhrase: k.phrase,
        details: { from: prev.position, to: k.position, volume: k.volume, url: k.url },
      });
    }
  }

  // --- new_page: unseen URL ranking for ≥2 keywords (top 30) ---
  const urlKeywords = new Map<string, SnapshotKeyword[]>();
  for (const k of latest) {
    if (!k.url || k.position == null || k.position > 30) continue;
    if (prevUrls.has(k.url)) continue;
    const list = urlKeywords.get(k.url) ?? [];
    list.push(k);
    urlKeywords.set(k.url, list);
  }
  for (const [url, ks] of urlKeywords) {
    if (ks.length >= 2) {
      events.push({
        eventType: "new_page",
        keywordPhrase: null,
        details: {
          url,
          keywordCount: ks.length,
          keywords: ks.slice(0, 5).map((k) => ({ phrase: k.phrase, position: k.position })),
        },
      });
    }
  }

  // --- lost_to_competitor: head-to-head on our tracked keywords ---
  const latestByPhrase = new Map<string, SnapshotKeyword>();
  for (const k of latest) latestByPhrase.set(normalizePhrase(k.phrase), k);
  for (const t of ourTracked) {
    const them = latestByPhrase.get(normalizePhrase(t.phrase));
    const theirPos = them?.position ?? null;
    const lostNow = theirPos != null && (t.current == null || theirPos < t.current);
    const lostBefore =
      theirPos != null &&
      prevByPhrase.get(normalizePhrase(t.phrase))?.position != null &&
      (t.previous == null || prevByPhrase.get(normalizePhrase(t.phrase))!.position! < t.previous);
    if (lostNow && !lostBefore) {
      events.push({
        eventType: "lost_to_competitor",
        keywordPhrase: t.phrase,
        details: {
          ourPosition: t.current,
          competitorPosition: theirPos,
          competitorUrl: them?.url ?? null,
          previousOurPosition: t.previous,
        },
      });
    }
  }

  return events;
}

interface Emitter {
  (input: {
    workspaceId: string;
    projectId: string;
    trigger: string;
    severity: "info" | "warn" | "critical";
    title: string;
    body: string;
    link: string;
    dedupKey?: string;
  }): Promise<unknown>;
}

/**
 * Capture a fresh competitor snapshot for one competitor, diff against the
 * previous snapshot, persist events, and emit one summary alert. Best-effort:
 * provider/alert failures never break the run.
 */
export async function captureAndDiffCompetitor(
  project: { id: string; workspaceId: string; domain: string },
  competitorDomain: string,
  fetchKeywords: () => Promise<SnapshotKeyword[]>,
  mock: boolean,
  emit: Emitter,
  audit: (action: "radar_event_detected", summary: string) => Promise<void>,
): Promise<{ events: RadarEvent[]; snapshotId: string | null }> {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);

  let rows: SnapshotKeyword[];
  try {
    rows = await fetchKeywords();
  } catch (err) {
    console.error(`Radar snapshot failed for ${competitorDomain}:`, err);
    return { events: [], snapshotId: null };
  }

  const previous = await prisma.competitorSnapshot.findFirst({
    where: { projectId: project.id, competitorDomain },
    orderBy: { capturedAt: "desc" },
  });
  const prevKeywords = previous
    ? (previous.keywordsJson as SnapshotKeyword[] | null) ?? []
    : null;

  const snapshot = await prisma.competitorSnapshot.create({
    data: {
      projectId: project.id,
      competitorDomain,
      capturedAt: now,
      keywordsJson: rows.slice(0, SNAPSHOT_LIMIT) as unknown as object,
      mock,
    },
  });

  // Our tracked keywords with latest + previous positions for head-to-head.
  const tracked = await prisma.keyword.findMany({
    where: { projectId: project.id, tracked: true },
    select: { id: true, phrase: true },
  });
  const ourTracked: OurTrackedPosition[] = [];
  for (const kw of tracked) {
    const hist = await prisma.ranking.findMany({
      where: { keywordId: kw.id },
      orderBy: { checkedAt: "desc" },
      take: 2,
      select: { position: true },
    });
    ourTracked.push({
      phrase: kw.phrase,
      current: hist[0]?.position ?? null,
      previous: hist[1]?.position ?? null,
    });
  }

  const events = diffCompetitorSnapshots(prevKeywords, rows, ourTracked);

  for (const e of events) {
    await prisma.competitorRadarEvent.create({
      data: {
        projectId: project.id,
        competitorDomain,
        eventType: e.eventType,
        keywordPhrase: e.keywordPhrase,
        details: e.details as unknown as object,
        detectedAt: now,
      },
    });
  }

  if (events.length > 0) {
    await audit(
      "radar_event_detected",
      `Radar: ${events.length} event(s) for ${competitorDomain} vs ${project.domain}`,
    ).catch(() => {});

    const losses = events.filter((e) => e.eventType === "lost_to_competitor");
    const severity = losses.length > 0 ? "critical" : "info";
    const headline =
      losses.length > 0
        ? `lost "${losses[0].keywordPhrase}" to ${competitorDomain}`
        : `${events.length} movement(s) detected for ${competitorDomain}`;
    try {
      await emit({
        workspaceId: project.workspaceId,
        projectId: project.id,
        trigger: "competitor_radar",
        severity,
        title: `🎯 Competitor radar: ${headline}`,
        body: events
          .slice(0, 5)
          .map((e) => `• ${e.eventType.replace(/_/g, " ")}${e.keywordPhrase ? `: "${e.keywordPhrase}"` : ""}`)
          .join("\n"),
        link: `/dashboard/projects/${project.id}/radar`,
        dedupKey: `radar:${competitorDomain}:${dayKey}`,
      });
    } catch {
      // alert failures never break the radar run
    }
  }

  return { events, snapshotId: snapshot.id };
}

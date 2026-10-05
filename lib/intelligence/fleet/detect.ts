// Marketr — Phase 10 M4: self-hosted change detection for tracked
// competitor URLs (changedetection.io pattern).
//
// For each tracked URL: check robots.txt (never fetch a disallowed URL),
// polite-fetch the page, normalize + hash, diff against the stored snapshot.
// On change → classify + write a CompetitorChange row (status "new",
// summaries filled later by summarize.ts). First sighting only stores the
// baseline snapshot — no change row.
//
// Politeness: PoliteFetcher (≥2s/domain, 15s timeout, identifiable UA) +
// robots crawl-delay honored when larger.

import { createHash } from "node:crypto";
import type { TxClient } from "@/lib/substrate/graph/rls";
import {
  MAX_TRACKED_URLS,
  extractMeta,
  loadSnapshots,
  normalizeText,
  saveSnapshots,
} from "./snapshots";
import { classifyChange } from "./classify";
import { PoliteFetcher, isOnWatchedDomain } from "./polite-fetch";
import {
  FLEET_BOT_TOKEN,
  crawlDelayFor,
  createRobotsCache,
  isAllowed,
  parseRobots,
  type RobotsCache,
} from "./robots";

export interface DetectDeps {
  tx: TxClient;
  workspaceId: string;
  watch: { id: string; competitorDomain: string };
  /** Tracked URLs (e.g. from watch.newUrls, or user-pinned). Capped. */
  trackedUrls: string[];
  fetcher?: PoliteFetcher;
  robotsCache?: RobotsCache;
}

export interface DetectionResult {
  watchId: string;
  checked: number;
  changed: number;
  skippedRobots: string[];
  errors: Array<{ url: string; error: string }>;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function robotsRulesFor(
  tx: TxClient,
  fetcher: PoliteFetcher,
  cache: RobotsCache,
  domain: string,
): Promise<{ disallowed: (url: string) => boolean; crawlDelay?: number }> {
  const cached = cache.get(domain);
  if (cached !== undefined) {
    const rules = cached;
    return {
      disallowed: (url) => (rules ? !isAllowed(rules, FLEET_BOT_TOKEN, url) : false),
      crawlDelay: rules ? crawlDelayFor(rules, FLEET_BOT_TOKEN) : undefined,
    };
  }
  try {
    const page = await fetcher.get(`https://${domain}/robots.txt`);
    if (page.status === 200) {
      const rules = parseRobots(page.text);
      cache.set(domain, rules);
      const delay = crawlDelayFor(rules, FLEET_BOT_TOKEN);
      if (delay) fetcher.setCrawlDelay(domain, delay);
      return {
        disallowed: (url) => !isAllowed(rules, FLEET_BOT_TOKEN, url),
        crawlDelay: delay,
      };
    }
  } catch {
    // robots.txt unreachable → treat as allow-all, don't fail the run
  }
  cache.set(domain, null);
  return { disallowed: () => false };
}

export async function runChangeDetection(deps: DetectDeps): Promise<DetectionResult> {
  const { tx, workspaceId, watch } = deps;
  const fetcher = deps.fetcher ?? new PoliteFetcher();
  const robotsCache = deps.robotsCache ?? createRobotsCache();
  const urls = [...new Set(deps.trackedUrls)].slice(0, MAX_TRACKED_URLS);

  const snapshots = await loadSnapshots(tx, workspaceId, watch.id);
  const robotsByDomain = new Map<string, Awaited<ReturnType<typeof robotsRulesFor>>>();

  const result: DetectionResult = {
    watchId: watch.id,
    checked: 0,
    changed: 0,
    skippedRobots: [],
    errors: [],
  };

  for (const url of urls) {
    let domain: string;
    try {
      domain = new URL(url).hostname.toLowerCase();
    } catch {
      result.errors.push({ url, error: "malformed URL" });
      continue;
    }
    if (!isOnWatchedDomain(url, watch.competitorDomain)) {
      // H8: tracked URLs come from competitor-controlled sitemaps; never
      // fetch anything off the watched domain.
      result.errors.push({ url, error: "off-domain URL refused" });
      continue;
    }
    if (!robotsByDomain.has(domain)) {
      robotsByDomain.set(domain, await robotsRulesFor(tx, fetcher, robotsCache, domain));
    }
    const robots = robotsByDomain.get(domain)!;
    if (robots.disallowed(url)) {
      result.skippedRobots.push(url);
      continue;
    }

    let page: { status: number; text: string };
    try {
      page = await fetcher.get(url);
    } catch (err) {
      result.errors.push({ url, error: err instanceof Error ? err.message : "fetch failed" });
      continue;
    }
    if (page.status < 200 || page.status >= 300) {
      result.errors.push({ url, error: `HTTP ${page.status}` });
      continue;
    }

    result.checked++;
    const text = normalizeText(page.text);
    const meta = extractMeta(page.text);
    const hash = sha256(text);
    const prev = snapshots[url];

    if (!prev) {
      // Baseline: store the snapshot, don't emit a change.
      snapshots[url] = { url, hash, text, ...meta, fetchedAt: new Date().toISOString() };
      continue;
    }
    if (prev.hash === hash) continue;

    const classified = classifyChange(
      { text: prev.text, title: prev.title, metaDescription: prev.metaDescription },
      { text, title: meta.title, metaDescription: meta.metaDescription },
    );
    // No rawHtml passed: the snapshot store keeps normalized text only
    // (bounded by design), so the structure heuristic can't compare old raw
    // html — text changes classify conservatively as content_updated. The
    // pure classifier still supports raw-html structure detection for
    // callers that have it (see classify.ts tests).

    await tx.competitorChange.create({
      data: {
        workspaceId,
        watchId: watch.id,
        url,
        changeType: classified.changeType,
        semanticSummary: null,
        whyItMatters: null,
        recommendedResponse: null,
        status: "new",
      },
    });
    result.changed++;
    snapshots[url] = { url, hash, text, ...meta, fetchedAt: new Date().toISOString() };
  }

  await saveSnapshots(tx, workspaceId, watch, snapshots);
  return result;
}

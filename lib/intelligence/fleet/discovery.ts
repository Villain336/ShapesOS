// Marketr — Phase 10 M4: weekly new-page discovery over competitor sitemaps.
//
// For each CompetitorWatch row: fetch the competitor's sitemap.xml (following
// sitemap indexes), diff URLs against the fleet's previous state, and write
// CompetitorChange rows:
//   - page_added      — URL in the sitemap we have never seen
//   - page_removed    — previously seen URL gone from the sitemap
//   - metadata_updated — known URL whose sitemap lastmod is newer than our
//                        last diff run (sitemap says it changed; the tracked-
//                        URL detector in detect.ts confirms with a real fetch)
//
// Previous state is derived from CompetitorChange history (no schema change):
// "seen" = every URL with a page_added/content_updated/metadata_updated/
// structure_changed row for this watch. Google Alerts is the documented
// consumer-tool baseline for indexed new pages — see google-alerts.ts
// (guidance only; Marketr never scrapes Google Alerts).

import { createHash } from "node:crypto";
import type { TxClient } from "@/lib/substrate/graph/rls";
import type { CompetitorChangeType } from "@prisma/client";
import type { SitemapDiff, SitemapEntry } from "./types";
import { fetchSitemapEntries } from "./sitemap";
import { PoliteFetcher } from "./polite-fetch";

export interface WatchRow {
  id: string;
  workspaceId: string;
  projectId: string;
  competitorDomain: string;
  sitemapUrl: string | null;
  lastDiffAt: Date | null;
}

export interface DiscoveryDeps {
  tx: TxClient;
  watch: WatchRow;
  fetcher?: PoliteFetcher;
  /** Cap on new change rows per run (safety). Default 200. */
  maxNewRows?: number;
}

export interface DiscoveryResult {
  watchId: string;
  competitorDomain: string;
  diff: SitemapDiff;
  rowsCreated: number;
  sitemapUrl: string;
  error?: string;
}

/** Bound on CompetitorWatch.newUrls (latest added URLs, spec semantics). */
const NEW_URLS_CAP = 500;

function defaultSitemapUrl(domain: string): string {
  return `https://${domain.replace(/\/+$/, "")}/sitemap.xml`;
}

/** Pure diff: current sitemap entries vs the previously seen URL set. */
export function diffSitemap(
  entries: SitemapEntry[],
  prevSeen: Set<string>,
  lastDiffAt: Date | null,
): SitemapDiff {
  const current = new Map<string, SitemapEntry>();
  for (const e of entries) {
    if (!current.has(e.url)) current.set(e.url, e);
  }
  const added: SitemapEntry[] = [];
  const updated: SitemapEntry[] = [];
  for (const [url, entry] of current) {
    if (!prevSeen.has(url)) {
      added.push(entry);
    } else if (entry.lastmod && lastDiffAt) {
      const lm = Date.parse(entry.lastmod);
      if (Number.isFinite(lm) && lm > lastDiffAt.getTime()) updated.push(entry);
    }
  }
  const removed = [...prevSeen].filter((u) => !current.has(u));
  return { added, removed, updated, totalSeen: current.size };
}

async function previouslySeenUrls(tx: TxClient, watchId: string): Promise<Set<string>> {
  const rows = await tx.competitorChange.findMany({
    where: {
      watchId,
      changeType: { in: ["page_added", "content_updated", "metadata_updated", "structure_changed"] },
    },
    select: { url: true },
  });
  return new Set(rows.map((r) => r.url));
}

/** URLs with an already-open page_removed / page_added row (status new or
 *  reviewed) — don't re-emit while the human hasn't dealt with the first. */
async function openChangeUrls(
  tx: TxClient,
  watchId: string,
  types: CompetitorChangeType[],
): Promise<Set<string>> {
  const rows = await tx.competitorChange.findMany({
    where: { watchId, changeType: { in: types }, status: { in: ["new", "reviewed"] } },
    select: { url: true },
  });
  return new Set(rows.map((r) => r.url));
}

export async function runDiscoveryForWatch(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const { tx, watch } = deps;
  const fetcher = deps.fetcher ?? new PoliteFetcher();
  const maxNewRows = deps.maxNewRows ?? 200;
  const domain = watch.competitorDomain;

  const candidates = watch.sitemapUrl
    ? [watch.sitemapUrl]
    : [defaultSitemapUrl(domain), `https://${domain}/sitemap_index.xml`];

  let entries: SitemapEntry[] = [];
  let usedUrl = candidates[0];
  let error: string | undefined;
  for (const candidate of candidates) {
    try {
      entries = await fetchSitemapEntries(candidate, (u) =>
        fetcher.get(u).then((p) => ({ status: p.status, text: p.text })),
      );
      if (entries.length > 0) {
        usedUrl = candidate;
        break;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "sitemap fetch failed";
    }
  }

  if (entries.length === 0) {
    return {
      watchId: watch.id,
      competitorDomain: domain,
      diff: { added: [], removed: [], updated: [], totalSeen: 0 },
      rowsCreated: 0,
      sitemapUrl: usedUrl,
      error: error ?? "sitemap empty or unreachable",
    };
  }

  const prevSeen = await previouslySeenUrls(tx, watch.id);
  const diff = diffSitemap(entries, prevSeen, watch.lastDiffAt);
  const openRemoved = await openChangeUrls(tx, watch.id, ["page_removed"]);
  const openAdded = await openChangeUrls(tx, watch.id, ["page_added"]);

  let rowsCreated = 0;
  const now = new Date();

  const createRow = async (url: string, changeType: CompetitorChangeType) => {
    if (rowsCreated >= maxNewRows) return;
    await tx.competitorChange.create({
      data: {
        workspaceId: watch.workspaceId,
        watchId: watch.id,
        url,
        changeType,
        // Summaries are filled in by summarize.ts; category is re-derived
        // there (no schema column for it — see summarize.ts).
        semanticSummary: null,
        whyItMatters: null,
        recommendedResponse: null,
        status: "new",
      },
    });
    rowsCreated++;
  };

  for (const e of diff.added) {
    if (openAdded.has(e.url)) continue;
    await createRow(e.url, "page_added");
  }
  for (const url of diff.removed) {
    if (openRemoved.has(url)) continue;
    await createRow(url, "page_removed");
  }
  for (const e of diff.updated) {
    await createRow(e.url, "metadata_updated");
  }

  const newUrls = diff.added.map((e) => e.url).slice(0, NEW_URLS_CAP);
  await tx.competitorWatch.update({
    where: { id: watch.id },
    data: { lastDiffAt: now, newUrls },
  });

  return {
    watchId: watch.id,
    competitorDomain: domain,
    diff,
    rowsCreated,
    sitemapUrl: usedUrl,
  };
}

/** Deterministic watch key helper (used by the API layer). */
export function watchFingerprint(domain: string, sitemapUrl: string | null): string {
  return createHash("sha256").update(`${domain}|${sitemapUrl ?? ""}`).digest("hex").slice(0, 16);
}

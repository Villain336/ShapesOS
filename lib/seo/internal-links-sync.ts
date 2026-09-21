// Marketr — internal-link suggestion sync (milestone 15).
//
// Orchestration around the pure engine (./internal-links.ts):
//   1. Gather known pages:
//      - latest ranking URL per tracked keyword (M5) with the keyword phrase
//        and best position;
//      - latest successful deployment URL per site (M9) — an honestly stored
//        page, with no keyword/rank data (orphan candidates by default).
//      M6/M7 working copies are connection-backed; no page inventory is
//      stored, so no crawl edges are claimed — extractInternalHrefs() exists
//      for a future crawl milestone to feed edges.
//   2. Run suggestInternalLinks() with the known edge set (empty until a
//      crawl exists — the engine is honest about unknown links).
//   3. Upsert pending suggestions (deduped by source/target); leave
//      applied/dismissed history untouched.
//
// Never edits pages. "Apply" in the UI creates an Issue in the fix-agent
// inbox (supervised).

import { prisma } from "@/lib/prisma";
import {
  normalizeInternalUrl,
  suggestInternalLinks,
  type InternalEdge,
  type InternalPage,
} from "./internal-links";

export interface InternalLinkSyncResult {
  pages: number;
  drafts: number;
  created: number;
  updated: number;
  skippedExisting: number;
}

/** Latest ranking URL per keyword for a project. */
export async function projectPages(projectId: string): Promise<InternalPage[]> {
  const keywords = await prisma.keyword.findMany({
    where: { projectId },
    select: {
      phrase: true,
      rankings: {
        orderBy: { checkedAt: "desc" },
        take: 1,
        select: { url: true, position: true },
      },
    },
  });

  const byUrl = new Map<string, InternalPage>();
  for (const k of keywords) {
    const r = k.rankings[0];
    if (!r?.url) continue;
    const key = normalizeInternalUrl(r.url);
    if (!key) continue;
    const existing = byUrl.get(key);
    if (existing) {
      if (!existing.targetKeywords.includes(k.phrase)) existing.targetKeywords.push(k.phrase);
      if (r.position != null && (existing.bestRank == null || r.position < existing.bestRank)) {
        existing.bestRank = r.position;
      }
    } else {
      byUrl.set(key, {
        url: r.url,
        targetKeywords: [k.phrase],
        bestRank: r.position ?? null,
      });
    }
  }
  // Latest successful deployment URL per site (M9) — stored, honest pages
  // with no keyword/rank data. They surface as orphan candidates until the
  // ranking graph or a future crawl links them in.
  const deployments = await prisma.deployment.findMany({
    where: { projectId, status: "success", url: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { siteId: true, url: true },
  });
  const seenSites = new Set<string>();
  for (const d of deployments) {
    if (!d.url || seenSites.has(d.siteId)) continue;
    seenSites.add(d.siteId);
    const key = normalizeInternalUrl(d.url);
    if (!key || byUrl.has(key)) continue;
    byUrl.set(key, { url: d.url, targetKeywords: [], bestRank: null });
  }

  return [...byUrl.values()];
}

/** Known internal edges for a project. Empty until a site crawl lands. */
export async function projectEdges(_projectId: string): Promise<InternalEdge[]> {
  // No crawl data is stored yet (M6/M7 sites are connection-backed).
  // Kept as an async seam: a future crawl milestone fills this in and the
  // engine + cron need no changes.
  return [];
}

export async function refreshInternalLinkSuggestions(
  projectId: string,
  workspaceId: string,
): Promise<InternalLinkSyncResult> {
  const pages = await projectPages(projectId);
  const edges = await projectEdges(projectId);
  const drafts = suggestInternalLinks(pages, edges);

  let created = 0;
  let updated = 0;
  let skippedExisting = 0;

  for (const d of drafts) {
    const existing = await prisma.internalLinkSuggestion.findFirst({
      where: {
        projectId,
        sourceUrl: d.sourceUrl,
        targetUrl: d.targetUrl,
        status: "pending",
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.internalLinkSuggestion.update({
        where: { id: existing.id },
        data: { suggestedAnchor: d.suggestedAnchor, reason: d.reason, score: d.score },
      });
      updated += 1;
    } else {
      const alreadyDecided = await prisma.internalLinkSuggestion.findFirst({
        where: {
          projectId,
          sourceUrl: d.sourceUrl,
          targetUrl: d.targetUrl,
          status: { in: ["applied", "dismissed"] },
        },
        select: { id: true },
      });
      if (alreadyDecided) {
        skippedExisting += 1;
        continue;
      }
      await prisma.internalLinkSuggestion.create({
        data: {
          projectId,
          sourceUrl: d.sourceUrl,
          targetUrl: d.targetUrl,
          suggestedAnchor: d.suggestedAnchor,
          reason: d.reason,
          score: d.score,
        },
      });
      created += 1;
    }
  }

  if (created > 0) {
    await prisma.fileChangeLog.create({
      data: {
        workspaceId,
        projectId,
        connectionId: null,
        filePath: "",
        actor: "system",
        action: "internal_link_suggestion_created",
        summary: `Internal-link sync: ${created} new suggestion${created === 1 ? "" : "s"} from ${pages.length} known pages`.slice(0, 280),
      },
    });
  }

  return { pages: pages.length, drafts: drafts.length, created, updated, skippedExisting };
}

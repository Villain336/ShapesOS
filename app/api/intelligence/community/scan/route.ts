// Marketr — POST /api/intelligence/community/scan (Phase 10 M8).
//
// Runs a community scan: discover (HN Algolia + Reddit official API +
// configured RSS) → rank → draft top N → taste gate → queue in the Phase 9
// approval inbox. dryRun=true discovers + ranks only (no LLM, no inbox).
//
// Body: {
//   reddit?: { clientId, clientSecret, refreshToken, username },  // user's own OAuth; omit = Reddit skipped
//   rssFeeds?: [{ name, url }],     // user-configured niche-forum feeds
//   queries?: string[],             // defaults to tracked keywords
//   maxDrafts?: number,             // default 5
//   dryRun?: boolean,
// }

import { scanCommunity } from "@/lib/intelligence/community";
import { intelligenceGuard, badRequest, readJson } from "../../_lib";

export const dynamic = "force-dynamic";

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20) : [];
}

export async function POST(req: Request) {
  const access = await intelligenceGuard("editor");
  if (access instanceof Response) return access;
  const body = await readJson(req);

  const redditRaw = body.reddit as Record<string, unknown> | undefined;
  const reddit =
    redditRaw && typeof redditRaw === "object"
      ? {
          clientId: String(redditRaw.clientId ?? ""),
          clientSecret: String(redditRaw.clientSecret ?? ""),
          refreshToken: String(redditRaw.refreshToken ?? ""),
          username: String(redditRaw.username ?? ""),
        }
      : null;

  const rssFeedsRaw = body.rssFeeds;
  const rssFeeds = Array.isArray(rssFeedsRaw)
    ? rssFeedsRaw
        .filter((f) => f && typeof f === "object")
        .map((f) => ({
          name: String((f as Record<string, unknown>).name ?? "feed").slice(0, 80),
          url: String((f as Record<string, unknown>).url ?? ""),
        }))
        .filter((f) => f.url.startsWith("http"))
        .slice(0, 20)
    : [];

  const maxDraftsRaw = body.maxDrafts;
  const maxDrafts =
    typeof maxDraftsRaw === "number" && Number.isFinite(maxDraftsRaw)
      ? Math.min(Math.max(Math.round(maxDraftsRaw), 0), 20)
      : 5;

  try {
    const report = await scanCommunity(
      {
        workspaceId: access.workspaceId,
        createdBy: access.userId,
        reddit,
        rssFeeds,
        queries: asStringArray(body.queries),
        maxDrafts,
        dryRun: body.dryRun === true,
      },
    );
    return Response.json({
      dryRun: report.dryRun,
      scannedAt: report.scannedAt,
      sources: report.sources,
      opportunities: report.opportunities.map((o) => ({
        source: o.source,
        title: o.title,
        url: o.url,
        author: o.author ?? null,
        feedName: o.feedName ?? null,
        score: o.score,
        signals: o.signals,
        matchedKeywords: o.matchedKeywords,
        relevanceReason: o.relevanceReason,
        createdAt: o.createdAt.toISOString(),
      })),
      queued: report.queued.map((q) => ({
        approvalId: q.approvalId,
        source: q.opportunity.source,
        title: q.opportunity.title,
        url: q.opportunity.url,
        draft: q.draft,
      })),
      tasteRejected: report.tasteRejected.map((t) => ({
        source: t.opportunity.source,
        title: t.opportunity.title,
        url: t.opportunity.url,
        failures: t.failures,
      })),
    });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Scan failed.");
  }
}

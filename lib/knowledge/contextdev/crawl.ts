// Marketr — Wave 2 context.dev slice 2: crawl execution + chunking.
//
// runCrawlJob executes one CrawlJob against the Context.dev API:
//   1. Source must be active (fail closed on pending_approval/archived).
//   2. Budget gate (checkAndReserve) runs BEFORE the API is hit.
//   3. sitemap sources: crawlSitemap → scrape up to maxPages URLs.
//      page sources: single scrapeMarkdown. brand sources: brand/retrieve
//      (stored as one chunk — the profile JSON, markdown-rendered).
//   4. Every page is split into chunks; each chunk is written to the
//      append-only KnowledgeChunk provenance ledger (source URL + fetch
//      time + content hash + workspace isolation).
//
// Pure helpers (chunkMarkdown, contentHash, estimateCrawlCost) are
// unit-tested. Errors never carry the API key.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { createContextDevClient, ContextDevError } from "./client";
import { contextDevCreditsFor } from "./costs";
import { checkAndReserve } from "./budget-store";
import { resolveContextDevKey } from "./keys";
import { extractDomain } from "./sources";

export class CrawlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CrawlError";
    this.code = code;
  }
}

export const DEFAULT_MAX_PAGES = 25;
export const MAX_PAGES_CAP = 100;
export const CHUNK_CHARS = 4000;
export const CHUNK_OVERLAP = 200;

/** Deterministic sha256 hex of a string. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Split markdown into ~maxChars chunks on paragraph boundaries, with
 * overlap so context survives the cut. Every paragraph survives whole in
 * at least one chunk; over-long paragraphs are hard-cut into windows.
 * Pure and deterministic.
 */
export function chunkMarkdown(markdown: string, maxChars: number = CHUNK_CHARS): string[] {
  const text = markdown.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const overlap = Math.min(CHUNK_OVERLAP, Math.floor(maxChars / 2));

  const paras = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";
  for (const para of paras) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // New chunk starts with the tail of the previous one, then the whole
    // new paragraph — the paragraph itself is never truncated by overlap.
    const tail = current ? current.slice(-overlap) : "";
    const next = tail ? `${tail}\n\n${para}` : para;
    if (next.length <= maxChars) {
      current = next;
    } else if (para.length > maxChars) {
      // Over-long paragraph: hard-cut it (with its own overlap windows).
      let rest = para;
      while (rest.length > maxChars) {
        chunks.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars - overlap);
      }
      current = rest;
    } else {
      // Tiny maxChars: even tail+para overflows — hard-cut the combination.
      let rest = next;
      while (rest.length > maxChars) {
        chunks.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars - overlap);
      }
      current = rest;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

/** Estimated credits for a crawl: 1 per page scrape (+1 for the sitemap call). */
export function estimateCrawlCost(sourceType: string, pageCount: number): number {
  const perPage = contextDevCreditsFor("scrape_markdown");
  if (sourceType === "sitemap") return contextDevCreditsFor("crawl_sitemap") + pageCount * perPage;
  if (sourceType === "brand") return contextDevCreditsFor("brand_retrieve");
  return perPage;
}

export interface RunCrawlOptions {
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export async function runCrawlJob(
  workspaceId: string,
  jobId: string,
  opts: RunCrawlOptions = {},
) {
  const maxPages = Math.min(Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES), MAX_PAGES_CAP);
  const job = await prisma.crawlJob.findFirst({
    where: { id: jobId, workspaceId },
    include: { source: true },
  });
  if (!job) throw new CrawlError("NOT_FOUND", "Crawl job not found");
  if (job.source.status !== "active") {
    throw new CrawlError(
      "SOURCE_NOT_ACTIVE",
      `Source is ${job.source.status} — approve it before crawling`,
    );
  }

  await prisma.crawlJob.update({
    where: { id: jobId },
    data: { status: "running", startedAt: new Date() },
  });

  const fail = async (code: string, message: string): Promise<never> => {
    await prisma.crawlJob.update({
      where: { id: jobId },
      data: { status: "failed", error: message, completedAt: new Date() },
    });
    throw new CrawlError(code, message);
  };

  try {
    const { apiKey } = await resolveContextDevKey(workspaceId);
    const client = createContextDevClient({ apiKey }, opts.fetchImpl ?? fetch);

    // Phase 1: discover URLs.
    let urls: string[];
    if (job.source.sourceType === "sitemap") {
      const gate = await checkAndReserve(workspaceId, contextDevCreditsFor("crawl_sitemap"));
      if (gate.decision !== "allow") {
        return fail("BUDGET_EXCEEDED", gate.reason);
      }
      const domain = extractDomain(job.source.url);
      const res = await client.crawlSitemap(domain, { maxLinks: maxPages });
      urls = res.urls.slice(0, maxPages);
    } else if (job.source.sourceType === "brand") {
      urls = [job.source.url];
    } else {
      urls = [job.source.url];
    }

    if (urls.length === 0) {
      const spent = job.source.sourceType === "sitemap" ? contextDevCreditsFor("crawl_sitemap") : 0;
      await prisma.crawlJob.update({
        where: { id: jobId },
        data: { status: "complete", creditsUsed: spent, completedAt: new Date() },
      });
      return { jobId, pagesFetched: 0, chunksWritten: 0, creditsUsed: spent };
    }

    // Phase 2: gate the scrape phase on the real page count, then scrape.
    // (The sitemap discovery call was already gated+charged in phase 1.)
    const scrapeCost =
      job.source.sourceType === "sitemap"
        ? urls.length * contextDevCreditsFor("scrape_markdown")
        : estimateCrawlCost(job.source.sourceType, urls.length);
    const gate = await checkAndReserve(workspaceId, scrapeCost);
    if (gate.decision !== "allow") {
      return fail("BUDGET_EXCEEDED", gate.reason);
    }

    const fetchedAt = new Date();
    let pagesFetched = 0;
    let chunksWritten = 0;
    const seenHashes = new Set<string>();

    for (const url of urls) {
      let markdown: string;
      if (job.source.sourceType === "brand") {
        const profile = await client.getBrandByDomain(extractDomain(url));
        markdown = [
          `# Brand profile: ${profile.name ?? profile.domain}`,
          profile.colors?.length ? `Colors: ${profile.colors.join(", ")}` : null,
          profile.fonts?.length ? `Fonts: ${profile.fonts.join(", ")}` : null,
          profile.industryCodes?.length ? `Industry codes: ${profile.industryCodes.join(", ")}` : null,
          profile.logos?.length
            ? `Logos:\n${profile.logos.map((l) => `- ${l.url}${l.variant ? ` (${l.variant})` : ""}`).join("\n")}`
            : null,
        ]
          .filter(Boolean)
          .join("\n\n");
      } else {
        const res = await client.scrapeMarkdown(url);
        markdown = res.markdown;
      }
      if (!markdown.trim()) continue;
      pagesFetched++;

      const chunks = chunkMarkdown(markdown);
      const rows = [];
      let ord = 0;
      for (const chunk of chunks) {
        const hash = contentHash(`${url}\n${chunk}`);
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
        ord++;
        rows.push({
          workspaceId,
          jobId,
          sourceId: job.source.id,
          sourceUrl: url,
          fetchedAt,
          ord,
          contentHash: hash,
          markdown: chunk,
        });
      }
      if (rows.length) {
        await prisma.knowledgeChunk.createMany({ data: rows });
        chunksWritten += rows.length;
      }
    }

    await prisma.crawlJob.update({
      where: { id: jobId },
      data: {
        status: "complete",
        pagesFetched,
        creditsUsed: scrapeCost + (job.source.sourceType === "sitemap" ? contextDevCreditsFor("crawl_sitemap") : 0),
        completedAt: new Date(),
      },
    });
    return {
      jobId,
      pagesFetched,
      chunksWritten,
      creditsUsed: scrapeCost + (job.source.sourceType === "sitemap" ? contextDevCreditsFor("crawl_sitemap") : 0),
    };
  } catch (err) {
    if (err instanceof CrawlError) throw err;
    const message =
      err instanceof ContextDevError
        ? `Context.dev ${err.code}`
        : err instanceof Error
          ? err.message
          : "Crawl failed";
    return fail(err instanceof ContextDevError ? err.code : "CRAWL_FAILED", message);
  }
}

/** Create a queued crawl job for an active source. */
export async function queueCrawlJob(workspaceId: string, sourceId: string) {
  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, workspaceId },
  });
  if (!source) throw new CrawlError("NOT_FOUND", "Knowledge source not found");
  if (source.status !== "active") {
    throw new CrawlError("SOURCE_NOT_ACTIVE", `Source is ${source.status} — approve it before crawling`);
  }
  return prisma.crawlJob.create({
    data: { workspaceId, sourceId, status: "queued" },
  });
}

export async function listCrawlJobs(workspaceId: string, limit = 50) {
  return prisma.crawlJob.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { source: { select: { url: true, sourceType: true } } },
  });
}

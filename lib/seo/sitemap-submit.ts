// ShapesOS Phase 11 (seotools): tell search engines about a site's sitemap.
//
//   Google Search Console  the project's connected GSC property (existing
//                          vault / OAuth: lib/intelligence/gsc getGscToken +
//                          the one GSC HTTP client, gscSubmitSitemap). Not
//                          connected → "not_connected"; a read-only grant →
//                          "needs_reconnect". Never reported as submitted
//                          unless Google accepted it.
//   IndexNow               keyless: POST api.indexnow.org with the page URLs
//                          and the site's key (lib/seo/sitemap indexNowKey —
//                          the key file ships with the site on publish).
//
// Every attempt is recorded in site_sitemap_submissions (FORCE RLS) with its
// real status. HTTP goes through safeFetch / the live connector layer.

import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";
import { gscSubmitSitemap } from "@/lib/intelligence/gsc/api";
import { getGscToken, type GscToken } from "@/lib/intelligence/gsc/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Prisma } from "@prisma/client";
import { readSiteWorkingCopy } from "@/lib/sites/files";
import type { WorkingCopyProvider } from "@/lib/connectors/local";
import { resolveLiveAuditUrl } from "@/lib/audit/project-audit";
import { indexNowKey, indexNowSecret, sitemapEntriesForFiles } from "./sitemap";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_MAX_URLS = 10_000;

export type SubmitTarget = "gsc" | "indexnow";
export type SubmitStatus = "submitted" | "not_connected" | "needs_reconnect" | "failed";

export interface SubmitResult {
  target: SubmitTarget;
  status: SubmitStatus;
  httpStatus: number | null;
  detail: string;
}

export interface SubmitDeps {
  fetchImpl?: typeof fetch;
  resolve?: ResolveFn;
  /** GSC token lookup (default: the project's connected property via the vault). */
  getToken?: (workspaceId: string, projectId: string) => Promise<GscToken>;
  /** Live-connector retry tuning (tests). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** POST the URLs to IndexNow. PURE apart from the request. */
export async function submitToIndexNow(
  input: { host: string; key: string; keyLocation: string; urls: string[] },
  deps: SubmitDeps = {},
): Promise<SubmitResult> {
  const urlList = input.urls.slice(0, INDEXNOW_MAX_URLS);
  if (!urlList.length) return { target: "indexnow", status: "failed", httpStatus: null, detail: "No pages to submit." };
  let res: Response;
  try {
    res = await safeFetch(
      INDEXNOW_ENDPOINT,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host: input.host, key: input.key, keyLocation: input.keyLocation, urlList }),
      },
      { fetchFn: deps.fetchImpl, resolve: deps.resolve },
    );
  } catch (err) {
    return { target: "indexnow", status: "failed", httpStatus: null, detail: `IndexNow could not be reached (${err instanceof Error ? err.message.slice(0, 120) : "error"}).` };
  }
  const s = res.status;
  if (s === 200 || s === 202) {
    return { target: "indexnow", status: "submitted", httpStatus: s, detail: `IndexNow accepted ${urlList.length} URL${urlList.length === 1 ? "" : "s"}${s === 202 ? " (key validation pending)" : ""}.` };
  }
  const why: Record<number, string> = {
    400: "IndexNow rejected the request format.",
    403: `IndexNow couldn't verify the key — publish the site so ${input.keyLocation} is live, then submit again.`,
    422: `IndexNow says the URLs don't belong to ${input.host} or the key doesn't match.`,
    429: "IndexNow is rate-limiting this host — try again later.",
  };
  return { target: "indexnow", status: "failed", httpStatus: s, detail: why[s] ?? `IndexNow answered HTTP ${s}.` };
}

/** Submit the sitemap URL to the project's Search Console property. */
export async function submitToSearchConsole(
  input: { workspaceId: string; projectId: string; sitemapUrl: string },
  deps: SubmitDeps = {},
): Promise<SubmitResult> {
  let token: GscToken;
  try {
    token = await (deps.getToken ?? getGscToken)(input.workspaceId, input.projectId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    const expired = /expired|refresh/i.test(msg);
    return {
      target: "gsc",
      status: expired ? "needs_reconnect" : "not_connected",
      httpStatus: null,
      detail: expired ? "The Search Console connection expired — reconnect it." : "Search Console isn't connected for this project.",
    };
  }
  try {
    await gscSubmitSitemap({ token: token.accessToken, refresh: token.refresh }, token.property, input.sitemapUrl, {
      fetchImpl: deps.fetchImpl,
      resolve: deps.resolve,
      maxRetries: deps.maxRetries,
      sleep: deps.sleep,
    });
    return { target: "gsc", status: "submitted", httpStatus: 200, detail: `Submitted ${input.sitemapUrl} to ${token.property}.` };
  } catch (err) {
    if (err instanceof ConnectorApiError) {
      if (err.code === "forbidden" || err.code === "auth_rejected") {
        return {
          target: "gsc",
          status: "needs_reconnect",
          httpStatus: err.status ?? null,
          detail: `Search Console refused the submission (${token.property}): the connection is read-only or doesn't own this property. Reconnect with sitemap permission.`,
        };
      }
      return { target: "gsc", status: "failed", httpStatus: err.status ?? null, detail: err.message.slice(0, 300) };
    }
    return { target: "gsc", status: "failed", httpStatus: null, detail: err instanceof Error ? err.message.slice(0, 300) : "Submission failed." };
  }
}

export class SitemapSubmitError extends Error {
  constructor(
    readonly code: "no_origin" | "no_pages",
    message: string,
  ) {
    super(message);
    this.name = "SitemapSubmitError";
  }
}

export interface SiteSubmitInput {
  workspaceId: string;
  projectId: string;
  siteId: string;
  targets?: SubmitTarget[];
  submittedBy?: string | null;
  /** Test seams. */
  provider?: WorkingCopyProvider;
  origin?: string | null;
  secret?: string | null;
}

export interface SiteSubmitOutcome {
  sitemapUrl: string;
  urlCount: number;
  results: SubmitResult[];
}

/** Submit a site's sitemap to each target and record every attempt. */
export async function submitSiteSitemap(input: SiteSubmitInput, deps: SubmitDeps = {}): Promise<SiteSubmitOutcome> {
  const live = input.origin ?? (await resolveLiveAuditUrl(input.siteId, input.projectId));
  let origin: string | null = null;
  try {
    origin = live ? new URL(live).origin : null;
  } catch {
    origin = null;
  }
  if (!origin) throw new SitemapSubmitError("no_origin", "The site has no live URL yet — deploy it (or set the project domain) before submitting a sitemap.");
  const { files } = await readSiteWorkingCopy(input.siteId, input.provider);
  const entries = sitemapEntriesForFiles(files, origin);
  if (!entries.length) throw new SitemapSubmitError("no_pages", "The site has no indexable pages to submit.");
  const sitemapUrl = `${origin}/sitemap.xml`;
  const targets: SubmitTarget[] = input.targets?.length ? [...new Set(input.targets)] : ["gsc", "indexnow"];

  const results: SubmitResult[] = [];
  for (const target of targets) {
    if (target === "gsc") {
      results.push(await submitToSearchConsole({ workspaceId: input.workspaceId, projectId: input.projectId, sitemapUrl }, deps));
    } else {
      const secret = input.secret === undefined ? indexNowSecret() : input.secret;
      if (!secret) {
        results.push({ target: "indexnow", status: "failed", httpStatus: null, detail: "No server secret to derive the IndexNow key from (MARKETR_CREDENTIALS_KEY)." });
        continue;
      }
      const key = indexNowKey(input.siteId, secret);
      results.push(
        await submitToIndexNow({ host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urls: entries.map((e) => e.loc) }, deps),
      );
    }
  }

  await withWorkspaceScope(input.workspaceId, async (raw) => {
    const tx = raw as Prisma.TransactionClient;
    for (const r of results) {
      await tx.siteSitemapSubmission.create({
        data: {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          target: r.target,
          status: r.status,
          sitemapUrl,
          urlCount: entries.length,
          httpStatus: r.httpStatus,
          detail: r.detail.slice(0, 1000),
          submittedBy: input.submittedBy ?? null,
        },
      });
    }
  });
  return { sitemapUrl, urlCount: entries.length, results };
}

/** Recent submissions for a site (newest first). */
export async function listSitemapSubmissions(workspaceId: string, siteId: string, take = 10) {
  return withWorkspaceScope(workspaceId, (raw) =>
    (raw as Prisma.TransactionClient).siteSitemapSubmission.findMany({
      where: { workspaceId, siteId },
      orderBy: { createdAt: "desc" },
      take,
    }),
  );
}

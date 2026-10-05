// ShapesOS — audit one site of a project (Phase 6: shared by the chat tool
// and the MCP tool, so both run the SAME real audit).
//
// Picks the site (the given id, else the project's first file-backed site),
// refuses content-only sources (WordPress/Webflow have no file tree), and
// runs lib/audit runAudit — a real scan, or the labelled mock scan when the
// site itself is a demo/mock connection (siteIsMock). The result's `mock`
// flag is the truth callers must report.

import type { SiteSourceType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getSiteIdeProvider, siteIsMock } from "@/lib/connectors/source";
import { runAudit } from "./audit";
import type { PageRenderer } from "./live";

const CONTENT_ONLY: SiteSourceType[] = ["wordpress", "webflow"];

export class AuditTargetError extends Error {
  constructor(
    readonly code: "no_auditable_site" | "content_only_site" | "no_live_url",
    message: string,
  ) {
    super(message);
    this.name = "AuditTargetError";
  }
}

/**
 * Phase 11 (seotools): the URL a live audit of this site starts from — the
 * newest real (non-mock) ready deployment, else the project's domain. Null
 * when neither is known (the caller must then ask for a URL).
 */
export async function resolveLiveAuditUrl(siteId: string, projectId: string): Promise<string | null> {
  const dep = await prisma.deployment.findFirst({
    where: { siteId, projectId, mock: false, status: "ready", url: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { url: true },
  });
  if (dep?.url) return /^https?:\/\//i.test(dep.url) ? dep.url : `https://${dep.url}`;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { domain: true } });
  const domain = project?.domain?.trim();
  if (!domain) return null;
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain.replace(/^\/+/, "")}`;
}

export async function auditProjectSite(input: {
  projectId: string;
  siteId?: string | null;
  /** The MCP runner already charged site_audit before the call (T14). */
  skipMetering?: boolean;
  /** Phase 11: crawl the live site. `url` overrides the resolved start URL. */
  live?: { url?: string | null; maxPages?: number; renderer?: PageRenderer | null } | null;
}) {
  const { projectId, siteId } = input;
  if (input.live) return auditProjectSiteLive({ ...input, live: input.live });
  const site = siteId
    ? await prisma.site.findFirst({
        where: { id: siteId, projectId },
        include: { sftpConnection: true },
      })
    : await prisma.site.findFirst({
        where: { projectId, sourceType: { notIn: CONTENT_ONLY } },
        orderBy: { createdAt: "asc" },
        include: { sftpConnection: true },
      });
  if (!site) {
    throw new AuditTargetError("no_auditable_site", "No auditable site found in this project");
  }
  if (CONTENT_ONLY.includes(site.sourceType)) {
    throw new AuditTargetError(
      "content_only_site",
      "Audits scan site files — this site is a content-level source with no file tree",
    );
  }
  const mock = siteIsMock(site as never);
  const provider = mock ? null : await getSiteIdeProvider(site as never);
  const result = await runAudit({
    siteId: site.id,
    projectId,
    siteName: site.name,
    provider,
    mock,
    skipMetering: input.skipMetering,
  });
  return { site: { id: site.id, name: site.name }, mock, result };
}

/** Phase 11: a live crawl works for every source type (WordPress and Webflow too). */
async function auditProjectSiteLive(input: {
  projectId: string;
  siteId?: string | null;
  skipMetering?: boolean;
  live: { url?: string | null; maxPages?: number; renderer?: PageRenderer | null };
}) {
  const { projectId, siteId } = input;
  const site = siteId
    ? await prisma.site.findFirst({ where: { id: siteId, projectId } })
    : await prisma.site.findFirst({ where: { projectId }, orderBy: { createdAt: "asc" } });
  if (!site) throw new AuditTargetError("no_auditable_site", "No site found in this project");
  const url = input.live.url?.trim() || (await resolveLiveAuditUrl(site.id, projectId));
  if (!url) {
    throw new AuditTargetError(
      "no_live_url",
      "This site has no live URL yet (no deployment and no project domain) — pass the URL to crawl",
    );
  }
  const result = await runAudit({
    siteId: site.id,
    projectId,
    siteName: site.name,
    provider: null,
    mock: false,
    skipMetering: input.skipMetering,
    live: { url, maxPages: input.live.maxPages, renderer: input.live.renderer ?? null },
  });
  return { site: { id: site.id, name: site.name }, mock: false, result };
}

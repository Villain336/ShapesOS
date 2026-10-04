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

const CONTENT_ONLY: SiteSourceType[] = ["wordpress", "webflow"];

export class AuditTargetError extends Error {
  constructor(
    readonly code: "no_auditable_site" | "content_only_site",
    message: string,
  ) {
    super(message);
    this.name = "AuditTargetError";
  }
}

export async function auditProjectSite(input: {
  projectId: string;
  siteId?: string | null;
  /** The MCP runner already charged site_audit before the call (T14). */
  skipMetering?: boolean;
}) {
  const { projectId, siteId } = input;
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

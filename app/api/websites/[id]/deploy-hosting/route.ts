// Marketr — deploy a site's working copy to Vercel / Cloudflare Pages (milestone 9).
// POST /api/websites/[id]/deploy-hosting { projectId, connectionId }
//   → { ok, url, deploymentId, status, mock }
// Collects every file in the site's local working copy, deploys through the
// chosen hosting connection, persists a Deployment row, and audit-logs it.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { readJsonBody } from "@/lib/sitefiles/api";
import { prisma } from "@/lib/prisma";
import {
  collectAllFiles,
  getSiteIdeProvider,
  ownedSite,
} from "@/lib/connectors/source";
import {
  hostingConnectorFor,
  hostingKindLabel,
  ownedHostingConnection,
  type DeployFile,
} from "@/lib/deploy";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await readJsonBody<{ projectId?: string; connectionId?: string }>(req);
  const site = await ownedSite(user.id, body?.projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const conn = await ownedHostingConnection(user.id, body?.projectId, body?.connectionId);
  if (!conn) return Response.json({ error: "Hosting connection not found" }, { status: 404 });

  const target = hostingConnectorFor(conn);

  try {
    const working = await getSiteIdeProvider(site);
    const paths = await collectAllFiles(working);
    if (!paths.length)
      return Response.json({ error: "The site has no files to deploy." }, { status: 400 });

    const files: DeployFile[] = [];
    for (const p of paths) {
      const { content } = await working.readFile(p);
      files.push({ path: p.replace(/^\//, ""), content });
    }

    const result = await target.deploy(files, { projectName: site.name });

    const deployment = await prisma.deployment.create({
      data: {
        siteId: site.id,
        projectId: site.projectId,
        connectionId: conn.id,
        target: conn.target,
        url: result.url,
        deploymentId: result.deploymentId,
        status: result.status,
        mock: result.mock === true,
      },
    });

    await prisma.fileChangeLog.create({
      data: {
        projectId: site.projectId,
        siteId: site.id,
        filePath: "/",
        actor: "user",
        action: "deploy",
        summary: `Deployed to ${hostingKindLabel(target.kind)}: ${result.url}${result.mock ? " (mock)" : ""}`,
      },
    });

    return Response.json({
      ok: true,
      deploymentId: result.deploymentId,
      url: result.url,
      status: result.status,
      mock: result.mock === true,
      recordId: deployment.id,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Deploy failed" },
      { status: 502 },
    );
  }
}

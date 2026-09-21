// Marketr — list a site's deployments (milestone 9).
// GET /api/websites/[id]/deployments?projectId=…
//   → { deployments: [{ id, target, url, deploymentId, status, mock, createdAt }] }

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { ownedSite } from "@/lib/connectors/source";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  const site = await ownedSite(user.id, projectId, id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

  const rows = await prisma.deployment.findMany({
    where: { siteId: site.id },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({
    deployments: rows.map((d) => ({
      id: d.id,
      target: d.target,
      targetLabel: d.target === "vercel" ? "Vercel" : "Cloudflare Pages",
      url: d.url,
      deploymentId: d.deploymentId,
      status: d.status,
      mock: d.mock,
      createdAt: d.createdAt.toISOString(),
    })),
  });
}

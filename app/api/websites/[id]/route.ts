// Marketr — single-site API (milestone 7).
// GET    /api/websites/[id]?projectId=… → { site } (no secrets)
// DELETE /api/websites/[id]?projectId=… → { ok }
// Deleting a site also removes its local working copy from disk.

import type { NextRequest } from "next/server";
import { promises as fs } from "fs";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireProjectRole, forbidden } from "@/lib/authz";
import { ownedSite, publicSite } from "@/lib/connectors/source";
import { siteWorkingDir } from "@/lib/connectors/local";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const site = await ownedSite(user.id, req.nextUrl.searchParams.get("projectId"), id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  return Response.json({ site: publicSite(site) });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const site = await ownedSite(user.id, req.nextUrl.searchParams.get("projectId"), id);
  if (!site) return Response.json({ error: "Site not found" }, { status: 404 });
  // Milestone 11: site deletion is admin+.
  if (!(await requireProjectRole(user.id, site.projectId, "admin"))) return forbidden();

  await prisma.site.delete({ where: { id: site.id } });
  // Best-effort: remove the working copy from disk.
  try {
    await fs.rm(siteWorkingDir(site.id), { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
  return Response.json({ ok: true });
}

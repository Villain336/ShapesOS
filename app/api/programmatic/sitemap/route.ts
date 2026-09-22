// Marketr — programmatic SEO sitemap API (milestone 17).
// GET /api/programmatic/sitemap?projectId=… → sitemap.xml of published
// programmatic pages (viewer+). Regenerated on disk (.data/sitemaps) after
// every publish; this endpoint always reflects the live published set.

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../util";
import { buildSitemapXml } from "@/lib/seo/programmatic-service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "viewer"))) return forbidden();

  const { xml } = await buildSitemapXml(project.id);
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

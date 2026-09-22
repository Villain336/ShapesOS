// Marketr — programmatic SEO export API (milestone 17).
// GET /api/programmatic/export?projectId=…[&templateId=][&status=]
//   → CSV download (url, canonical, title, description, html, noindex,
//   status, published_url) for WordPress/Webflow/connector import (editor+).

import { forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject, requireRole } from "../util";
import { tiptapToHtml } from "@/lib/seo/programmatic";

export const dynamic = "force-dynamic";

function csvCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const project = await ownedProject(user.id, req.nextUrl.searchParams.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  if (!(await requireRole(user.id, project.id, "editor"))) return forbidden();

  const templateId = req.nextUrl.searchParams.get("templateId");
  const status = req.nextUrl.searchParams.get("status");

  const pages = await prisma.programmaticPage.findMany({
    where: {
      projectId: project.id,
      ...(templateId ? { templateId } : {}),
      ...(status === "draft" || status === "ready" || status === "published" || status === "discarded"
        ? { status }
        : {}),
    },
    orderBy: { url: "asc" },
    take: 10000,
  });

  const header = ["url", "canonical", "title", "description", "html", "noindex", "status", "published_url"];
  const lines = [header.join(",")];
  for (const p of pages) {
    const content = (p.content ?? {}) as { title?: string; description?: string; contentBlocks?: unknown };
    lines.push(
      [
        csvCell(p.url),
        csvCell(p.canonical),
        csvCell(content.title),
        csvCell(content.description),
        csvCell(content.contentBlocks ? tiptapToHtml(content.contentBlocks) : ""),
        csvCell(p.noindex ? "1" : "0"),
        csvCell(p.status),
        csvCell(p.publishedUrl),
      ].join(","),
    );
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="programmatic-pages-${project.id}.csv"`,
    },
  });
}

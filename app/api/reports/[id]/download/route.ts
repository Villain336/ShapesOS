// Marketr — report PDF download (milestone 12).
// GET /api/reports/[id]/download → application/pdf stream (any member).

import type { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;

  const report = await prisma.report.findFirst({
    where: { id, template: { workspaceId: workspace.id } },
    include: { template: { select: { name: true } } },
  });
  if (!report || !report.pdfPath) {
    return Response.json({ error: "Report not found" }, { status: 404 });
  }
  if (report.status !== "ready") {
    return Response.json({ error: `Report is ${report.status}` }, { status: 409 });
  }

  const abs = path.isAbsolute(report.pdfPath)
    ? report.pdfPath
    : path.join(process.cwd(), report.pdfPath);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(abs);
  } catch {
    return Response.json({ error: "PDF file missing from storage" }, { status: 410 });
  }

  const filename = `${(report.template?.name ?? "report").replace(/[^a-z0-9-_]+/gi, "-")}-${report.period}.pdf`;
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.length),
    },
  });
}

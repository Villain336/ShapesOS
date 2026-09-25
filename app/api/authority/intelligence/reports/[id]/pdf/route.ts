// Marketr — GET /api/authority/intelligence/reports/:id/pdf
// Renders the Intelligence Report PDF on demand with the house takumi stack
// (@/lib/authority/intelligence/pdf.tsx) and streams the bytes. Renders are
// cached on disk (.data/reports/intelligence-<id>.pdf) and the row's pdfUrl
// is updated; every GET re-renders so the PDF always matches the stored
// bundle (including any human reprioritization of the 90-day plan).

import type { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { getReport, getReportBundle } from "@/lib/authority/intelligence/reports";
import { renderIntelligencePdf } from "@/lib/authority/intelligence/pdf";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  const { id } = await params;
  try {
    const row = await getReport(id, gate.workspaceId);
    if (!row) return Response.json({ error: "Report not found" }, { status: 404 });
    const bundle = await getReportBundle(id, gate.workspaceId);
    if (!bundle) return Response.json({ error: "Report data missing" }, { status: 404 });

    // Brand identity for the cover: first client record, else the workspace name.
    const client = await prisma.client.findFirst({
      where: { workspaceId: gate.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { name: true },
    });
    const workspace = await prisma.workspace.findUnique({
      where: { id: gate.workspaceId },
      select: { name: true },
    });
    const project = await prisma.project.findFirst({
      where: { workspaceId: gate.workspaceId },
      orderBy: { createdAt: "asc" },
      select: { domain: true },
    });

    const pdfUrl = await renderIntelligencePdf({
      reportId: row.id,
      brandName: client?.name ?? workspace?.name ?? "Intelligence Report",
      domain: project?.domain ?? null,
      audits: bundle.audits,
      opportunities: bundle.opportunities,
      plan: bundle.plan,
      generatedAt: bundle.generatedAt,
    });

    const abs = path.join(process.cwd(), pdfUrl);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(abs);
    } catch {
      return Response.json({ error: "PDF render failed: output file missing" }, { status: 500 });
    }

    const safe = `intelligence-report-${row.version}.pdf`;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safe}"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch (err) {
    return safetyError(err);
  }
}

// Marketr — studio creative re-validation (Phase 4, T2).
// POST /api/studio/creatives/[id]/validate (editor)
// Re-runs format validation against the stored PDF and persists the report.
// (Uploads validate automatically.)

import { prisma } from "@/lib/prisma";
import { readFile } from "@/lib/filesystem/service";
import {
  validateFormat,
  type ChannelTemplateId,
  type ValidationReport,
} from "@/lib/studio/creatives";
import { auditStudio } from "@/lib/studio/service";
import {
  creativeErrorResponse,
  guardWorkspace,
} from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const row = await prisma.mailCreative.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!row) return Response.json({ error: "Creative not found." }, { status: 404 });
    const prior = (row.validation ?? {}) as Partial<ValidationReport>;
    const fileId = prior.fileId;
    if (!fileId) {
      return Response.json({ error: "No PDF stored on this creative yet." }, { status: 409 });
    }
    const stored = await readFile({ workspaceId: workspace.id, fileId });
    if (!stored) return Response.json({ error: "Stored PDF is missing from the filesystem." }, { status: 410 });
    const report = validateFormat(
      row.channelTemplate as ChannelTemplateId,
      row.formatTrack,
      row.size,
      stored.bytes,
      { source: row.source },
    );
    report.fileId = fileId;
    // Re-validation never clears an existing §7 attestation — the attestation
    // covers the same stored bytes (hash unchanged), and mark-ready re-checks.
    report.attestation = prior.attestation ?? null;
    const updated = await prisma.mailCreative.update({
      where: { id: row.id },
      data: { validation: report as unknown as object },
    });
    await auditStudio(
      prisma, workspace.id, null, "studio_creative_validated",
      `Creative "${row.name}" v${row.version} re-validated: ${report.ok ? "pass" : "FAIL"}.`,
    );
    return Response.json({
      creative: {
        ...updated,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

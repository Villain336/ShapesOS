// Marketr — studio creative PDF download (Phase 4, T2).
// GET /api/studio/creatives/[id]/pdf
// Streams the stored print PDF. Workspace-scoped: the file id comes from the
// creative's own validation report, and readFile re-checks the workspace.

import { prisma } from "@/lib/prisma";
import { readFile } from "@/lib/filesystem/service";
import type { ValidationReport } from "@/lib/studio/creatives";
import {
  creativeErrorResponse,
  guardWorkspace,
} from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const row = await prisma.mailCreative.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!row) return Response.json({ error: "Creative not found." }, { status: 404 });
    const fileId = ((row.validation ?? {}) as Partial<ValidationReport>).fileId;
    if (!fileId) return Response.json({ error: "No PDF stored on this creative yet." }, { status: 404 });
    const stored = await readFile({ workspaceId: workspace.id, fileId });
    if (!stored) return Response.json({ error: "Stored PDF is missing from the filesystem." }, { status: 410 });
    const body = new Uint8Array(stored.bytes);
    return new Response(body, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${row.name.replace(/["\\]/g, "_")}-v${row.version}.pdf"`,
      },
    });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

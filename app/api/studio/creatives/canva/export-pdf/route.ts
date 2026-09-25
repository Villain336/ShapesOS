// Marketr — studio creative Canva PDF export (Phase 4, T2).
// Uses the max-quality "pdf_print" alias ({ type: "pdf", export_quality: "pro" });
// not the editor's PDF Print (no bleed/crop/CMYK in the Connect API).
// POST /api/studio/creatives/canva/export-pdf { creativeId, designId } (editor)
//   Start the export job (pdf_print alias = { type:"pdf", export_quality:"pro" }).
// GET  /api/studio/creatives/canva/export-pdf?creativeId=
//   Poll once; when the job succeeds the PDF is downloaded, validated against
//   the format track, stored, and hash-stamped on the creative. The client
//   polls this endpoint until status is success/failed.
// Money rule: never initiates without a connected Canva account (409).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  pollCreativePdfExport,
  startCreativePdfExport,
} from "@/lib/studio/creatives";
import {
  canvaClient,
  creativeErrorResponse,
  guardWorkspace,
  productionCanvaPort,
  readJson,
} from "../../_lib";

export const dynamic = "force-dynamic";

const StartSchema = z.object({
  creativeId: z.string().min(1).max(120),
  designId: z.string().min(1).max(120),
});

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const parsed = StartSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const result = await startCreativePdfExport(
      prisma,
      workspace.id,
      productionCanvaPort(),
      canvaClient(),
      parsed.data.creativeId,
      parsed.data.designId,
      "user",
    );
    return Response.json({ ...result, status: "in_progress" });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

export async function GET(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const creativeId = new URL(req.url).searchParams.get("creativeId") ?? "";
    if (!creativeId) return Response.json({ error: "creativeId is required." }, { status: 400 });
    const result = await pollCreativePdfExport(
      prisma,
      workspace.id,
      productionCanvaPort(),
      canvaClient(),
      creativeId,
      { createdBy: user.id },
    );
    return Response.json(result);
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

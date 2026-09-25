// Marketr — studio creative design-link round-trip (Phase 4, T2).
// POST /api/studio/creatives/canva/design-link { creativeId, shareUrl } (editor)
// Accepts a pasted Canva share URL, resolves the design id (verified against
// the connected account), links it to the draft creative, and starts the PDF
// export. The design-link only avoids re-typing the design id — it runs the
// SAME Connect API export as the direct flow, not the editor's PDF Print.
// For true press-ready PDF Print (bleed/crop/CMYK), the user downloads the
// file manually in the Canva editor and uploads it via the Upload PDF path.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  CreativeHttpError,
  resolveCanvaDesignLink,
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

const DesignLinkSchema = z.object({
  creativeId: z.string().min(1).max(120),
  shareUrl: z.string().trim().min(1).max(500),
});

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const parsed = DesignLinkSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const row = await prisma.mailCreative.findFirst({
      where: { id: parsed.data.creativeId, workspaceId: workspace.id },
    });
    if (!row) throw new CreativeHttpError(404, "Creative not found.");
    const { designId, title } = await resolveCanvaDesignLink(
      prisma,
      workspace.id,
      productionCanvaPort(),
      canvaClient(),
      parsed.data.shareUrl,
    );
    const started = await startCreativePdfExport(
      prisma,
      workspace.id,
      productionCanvaPort(),
      canvaClient(),
      row.id,
      designId,
      "user",
    );
    return Response.json({ designId, title, ...started, status: "in_progress" });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}

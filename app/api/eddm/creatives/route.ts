// Marketr — EDDM concierge API: EDDM-track creative picker data.
// GET /api/eddm/creatives → workspace MailCreative rows with
// formatTrack = "eddm" (read-only; Studio/T2 owns creative authoring).

import { prisma } from "@/lib/prisma";
import {
  guardWorkspace,
  httpErrorResponse,
} from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const creatives = await prisma.mailCreative.findMany({
      where: { workspaceId: workspace.id, formatTrack: "eddm" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        name: true,
        formatTrack: true,
        size: true,
        source: true,
        creativeHash: true,
        version: true,
        status: true,
        pdfUrl: true,
        updatedAt: true,
      },
    });
    return Response.json({ creatives, workspaceId: workspace.id });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

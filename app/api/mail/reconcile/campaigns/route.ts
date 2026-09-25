// Marketr — cost reconciliation: campaign picker data (read-only).
// GET /api/mail/reconcile/campaigns → workspace mail campaigns for the picker.

import { prisma } from "@/lib/prisma";
import {
  guardWorkspace,
  httpErrorResponse,
} from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const campaigns = await prisma.mailCampaign.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: {
        id: true,
        name: true,
        status: true,
        pieceCount: true,
        estCostCents: true,
        createdAt: true,
        mailedAt: true,
      },
    });
    return Response.json({ campaigns });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

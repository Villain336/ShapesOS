// Marketr — E-sign module API.
// GET /api/esign/agent/analytics — time-to-sign analytics, overall + per template.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { signingAnalytics } from "@/lib/esign/agent";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const stats = await signingAnalytics(prisma, { workspaceId: workspace.id });
    return Response.json({ analytics: stats });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

// Marketr — E-sign module API.
// POST /api/esign/agent/sweep-expirations — backstop: expire stale live envelopes.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { sweepExpirations } from "@/lib/esign/agent";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const res = await sweepExpirations(prisma, { workspaceId: workspace.id, actor: user.id });
    return Response.json(res);
  } catch (e) {
    return httpErrorResponse(e);
  }
}

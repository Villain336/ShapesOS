// Marketr — R6 prospect research API.
// POST /api/prospects/[id]/research (editor) → AI research agent run.
// Research only — nothing is ever sent from this endpoint.

import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, HttpError } from "@/lib/enrichment/guard";
import { researchProspect } from "@/lib/enrichment/research";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const exists = await prisma.prospect.findFirst({
      where: { id, workspaceId: workspace.id },
      select: { id: true },
    });
    if (!exists) throw new HttpError(404, "Prospect not found");
    const research = await researchProspect(workspace.id, id, user.id);
    return Response.json({ research });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

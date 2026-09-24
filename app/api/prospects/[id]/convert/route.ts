// Marketr — R6 prospect → lead conversion API.
// POST /api/prospects/[id]/convert (editor) { pipelineId? } → convertToLead.
// The closed loop: the lead carries sourceDetail "Prospecting list: <name>"
// so C2 attribution ties revenue back to the originating list.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { convertToLead } from "@/lib/enrichment/crm-sync";

const Schema = z.object({
  pipelineId: z.string().min(1).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const { lead, linkedExisting } = await convertToLead(
      workspace.id,
      id,
      parsed.data.pipelineId,
      user.id,
    );
    return Response.json({
      lead: {
        id: lead.id,
        name: lead.name,
        email: lead.email,
        company: lead.company,
        source: lead.source,
        sourceDetail: lead.sourceDetail,
        stage: lead.stage,
        score: lead.score,
      },
      linkedExisting,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

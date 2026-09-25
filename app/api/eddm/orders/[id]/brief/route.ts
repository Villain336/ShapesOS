// Marketr — EDDM concierge API: mailhouse handoff brief.
// POST /api/eddm/orders/[id]/brief (editor+) → render the handoff brief PDF,
//   store it on disk, set briefPdfUrl, and advance draft → briefed.
// The brief is a planning document: estimates only, no spend authorized.

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import { publicOrigin } from "@/lib/physical/bundles";
import { applyEddmStatus, getEddmOrder, type EddmPostageTier } from "@/lib/mail/eddm";
import { generateEddmBriefPdf } from "@/lib/mail/eddm-brief";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const BriefSchema = z.object({
  postageTier: z.enum(["retail", "bmeu"]).optional().default("retail"),
  printCentsPerPiece: z.number().min(0).max(1000).optional(),
});

export async function POST(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = BriefSchema.parse(await readJson(req));
    const origin = publicOrigin(req);

    const result = await generateEddmBriefPdf({
      workspaceId: workspace.id,
      orderId: id,
      postageTier: body.postageTier as EddmPostageTier,
      printCentsPerPiece: body.printCentsPerPiece,
      origin,
      actorUserId: user.id,
    });

    // A generated brief is the briefing: advance draft → briefed.
    const before = await getEddmOrder(workspace.id, id);
    let order = before;
    if (before && before.status === "draft") {
      order = await applyEddmStatus({
        workspaceId: workspace.id,
        id,
        to: "briefed",
        actorUserId: user.id,
      });
    }

    return Response.json({ ...result, order });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

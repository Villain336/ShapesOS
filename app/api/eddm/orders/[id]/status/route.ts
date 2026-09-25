// Marketr — EDDM concierge API: status transitions.
// POST /api/eddm/orders/[id]/status (editor+) → { to, dropDate? }.
// Transitions are validated: draft → briefed → at_mailhouse → dropped →
// complete (+ cancelled from draft/briefed/at_mailhouse). "dropped" mints
// the per-drop QR slug, sets the in-home window (drop + 3–7 days), and
// runs the attribution hook. No API send path — human/mailhouse executes.

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import { publicOrigin } from "@/lib/physical/bundles";
import {
  applyEddmStatus,
  EDDM_STATUSES,
  type EddmStatus,
} from "@/lib/mail/eddm";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const StatusSchema = z.object({
  to: z.enum(EDDM_STATUSES as [EddmStatus, ...EddmStatus[]]),
  dropDate: z.string().trim().optional(),
});

export async function POST(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = StatusSchema.parse(await readJson(req));
    let dropDate: Date | undefined;
    if (body.dropDate !== undefined) {
      dropDate = new Date(body.dropDate);
      if (Number.isNaN(dropDate.getTime())) {
        return Response.json({ error: "Invalid drop date." }, { status: 400 });
      }
    }
    const order = await applyEddmStatus({
      workspaceId: workspace.id,
      id,
      to: body.to,
      dropDate,
      origin: publicOrigin(req),
      actorUserId: user.id,
    });
    return Response.json({ order });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

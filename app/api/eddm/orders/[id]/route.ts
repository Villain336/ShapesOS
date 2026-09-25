// Marketr — EDDM concierge API: order detail + field updates.
// GET   /api/eddm/orders/[id] → order detail
// PATCH /api/eddm/orders/[id] (editor+) → name / mailhouse / drop date (draft|briefed)

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  coerceEddmRoutes,
  estimateEddmCost,
  getEddmOrderWithCreative,
  updateEddmOrderFields,
} from "@/lib/mail/eddm";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  mailhouse: z.string().trim().max(160).optional().nullable(),
  dropDate: z.string().trim().optional().nullable(),
});

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const order = await getEddmOrderWithCreative(workspace.id, id);
    if (!order) return Response.json({ error: "EDDM order not found" }, { status: 404 });
    return Response.json({
      order: {
        ...order,
        liveEstimate: estimateEddmCost({ routes: coerceEddmRoutes(order.routes) }),
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = PatchSchema.parse(await readJson(req));
    let dropDate: Date | null | undefined;
    if (body.dropDate !== undefined) {
      dropDate = body.dropDate ? new Date(body.dropDate) : null;
      if (dropDate && Number.isNaN(dropDate.getTime())) {
        return Response.json({ error: "Invalid drop date." }, { status: 400 });
      }
    }
    const order = await updateEddmOrderFields(workspace.id, id, {
      name: body.name,
      mailhouse: body.mailhouse,
      dropDate,
    });
    return Response.json({ order });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

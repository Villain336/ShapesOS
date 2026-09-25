// Marketr — EDDM concierge API: carrier-route table.
// GET /api/eddm/orders/[id]/routes → routes + validation summary
// PUT /api/eddm/orders/[id]/routes (editor+) → replace route table (draft only).
// v1 is manual entry — the UI notes "verify with mailhouse" because counts
// come from USPS EDDM data the mailhouse confirms.

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  coerceEddmRoutes,
  getEddmOrder,
  setEddmRoutes,
  validateEddmRoutes,
  type EddmPostageTier,
} from "@/lib/mail/eddm";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const RouteRowSchema = z.object({
  zip: z.string().trim().min(1).max(10),
  routeId: z.string().trim().min(1).max(16),
  households: z.number().int().min(1),
  selected: z.boolean().optional().default(true),
});

const PutSchema = z.object({
  routes: z.array(RouteRowSchema).min(1).max(500),
  postageTier: z.enum(["retail", "bmeu"]).optional().default("retail"),
});

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const order = await getEddmOrder(workspace.id, id);
    if (!order) return Response.json({ error: "EDDM order not found" }, { status: 404 });
    const routes = coerceEddmRoutes(order.routes);
    return Response.json({
      routes,
      pieceCount: order.pieceCount,
      validation: validateEddmRoutes(routes, "retail"),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = PutSchema.parse(await readJson(req));
    const order = await setEddmRoutes(
      workspace.id,
      id,
      body.routes,
      body.postageTier as EddmPostageTier,
    );
    return Response.json({
      order,
      validation: validateEddmRoutes(coerceEddmRoutes(order.routes), body.postageTier as EddmPostageTier),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

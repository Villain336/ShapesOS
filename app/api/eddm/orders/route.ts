// Marketr — EDDM concierge API: order list + creation.
// GET  /api/eddm/orders → orders (workspace-scoped, with creative + live estimate)
// POST /api/eddm/orders (editor+) → create a draft order

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  coerceEddmRoutes,
  createEddmOrder,
  estimateEddmCost,
  listEddmOrders,
} from "@/lib/mail/eddm";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  mailhouse: z.string().trim().max(160).optional().nullable(),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const orders = await listEddmOrders(workspace.id);
    return Response.json({
      orders: orders.map((o) => ({
        id: o.id,
        name: o.name,
        zips: o.zips,
        routes: o.routes,
        pieceCount: o.pieceCount,
        creative: o.creative,
        creativeId: o.creativeId,
        mailhouse: o.mailhouse,
        briefPdfUrl: o.briefPdfUrl,
        status: o.status,
        costCents: o.costCents,
        postageCents: o.postageCents,
        printCents: o.printCents,
        dropDate: o.dropDate,
        inHomeStart: o.inHomeStart,
        inHomeEnd: o.inHomeEnd,
        qrSlug: o.qrSlug,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        // Live estimate so the list always shows current math.
        liveEstimate: estimateEddmCost({ routes: coerceEddmRoutes(o.routes) }),
      })),
      workspaceId: workspace.id,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = CreateSchema.parse(await readJson(req));
    const order = await createEddmOrder({
      workspaceId: workspace.id,
      name: body.name,
      mailhouse: body.mailhouse ?? null,
      createdBy: user.id,
    });
    return Response.json({ order }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

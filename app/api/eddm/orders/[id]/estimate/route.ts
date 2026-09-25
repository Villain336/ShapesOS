// Marketr — EDDM concierge API: cost estimate.
// GET  /api/eddm/orders/[id]/estimate → live estimate from the route table
// POST /api/eddm/orders/[id]/estimate (editor+) → compute + persist totals.
// Estimates only — no real spend, ever.

import { z } from "zod";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  coerceEddmRoutes,
  estimateEddmCost,
  getEddmOrder,
  saveEddmEstimate,
  type EddmPostageTier,
} from "@/lib/mail/eddm";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const EstimateSchema = z.object({
  postageTier: z.enum(["retail", "bmeu"]).optional().default("retail"),
  printCentsPerPiece: z.number().min(0).max(1000).optional(),
});

export async function GET(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const order = await getEddmOrder(workspace.id, id);
    if (!order) return Response.json({ error: "EDDM order not found" }, { status: 404 });
    const url = new URL(req.url);
    const tier = (url.searchParams.get("postageTier") ?? "retail") as EddmPostageTier;
    const printRaw = url.searchParams.get("printCentsPerPiece");
    const estimate = estimateEddmCost({
      routes: coerceEddmRoutes(order.routes),
      postageTier: tier === "bmeu" ? "bmeu" : "retail",
      printCentsPerPiece: printRaw == null ? undefined : Number(printRaw),
    });
    return Response.json({ estimate });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = EstimateSchema.parse(await readJson(req));
    const { order, estimate } = await saveEddmEstimate(workspace.id, id, {
      postageTier: body.postageTier as EddmPostageTier,
      printCentsPerPiece: body.printCentsPerPiece,
    });
    return Response.json({ order, estimate });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

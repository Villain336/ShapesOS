// Marketr — CAD + Hardware slice 3 API.
// GET  /api/cad/rate-cards — list tenant rate cards (?process=).
// POST /api/cad/rate-cards — create a rate card (editor).
//        Rates are tenant-configured estimates; `source` is an optional
//        source pointer for ingested reference data (clean-sourcing).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { CadError } from "@/lib/cad/types";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["RATE_CARD_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadPipelineStore(prisma);
    const url = new URL(req.url);
    const rateCards = await store.listRateCards(
      workspace.id,
      url.searchParams.get("process") ?? undefined,
    );
    return Response.json({ rateCards });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = await req.json();
    const store = new PrismaCadPipelineStore(prisma);
    const rateCard = await store.createRateCard(
      workspace.id,
      user.email ?? user.id,
      {
        name: body?.name ?? "",
        process: body?.process ?? "",
        currency: body?.currency,
        rates: body?.rates,
        isDefault: body?.isDefault,
        source: body?.source,
      },
    );
    return Response.json({ rateCard }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

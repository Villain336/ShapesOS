// Marketr — Funding/VC slice 4 API.
// GET  /api/funding/rounds/[id]/cap-table — stakeholder rows + pure
//        fully-diluted rollup (total FD shares, % by type, top holder).
// POST /api/funding/rounds/[id]/cap-table — add a stakeholder (editor).
//        v1 is manual entry — no live Carta sync.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function fundingErrorResponse(e: FundingError) {
  return Response.json(
    { error: e.message, code: e.code },
    { status: e.code === "ROUND_NOT_FOUND" ? 404 : 400 },
  );
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaFundingStore(prisma);
    const { rows, rollup } = await store.listStakeholders(workspace.id, id);
    return Response.json({ workspaceId: workspace.id, roundId: id, rows, rollup });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as Record<string, unknown>;
    const store = new PrismaFundingStore(prisma);
    const row = await store.addStakeholder(workspace.id, id, body);
    return Response.json({ workspaceId: workspace.id, row }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

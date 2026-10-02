// Marketr — Funding/VC slice 2 API.
// GET /api/funding/investors/[id] — investor detail (profile, interaction
// timeline, follow-ups).
// PATCH /api/funding/investors/[id] — update enrichment fields
// (v1 = manual/structured entry; enriched requires fetchedAt).

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError, type InvestorEnrichmentInput } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

function fundingErrorResponse(e: FundingError) {
  const status = e.code === "investor_not_found" ? 404 : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const detail = await store.getInvestorDetail(workspace.id, id);
    return Response.json(detail);
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as InvestorEnrichmentInput;
    const store = new PrismaFundingStore(prisma);
    const investor = await store.updateInvestorEnrichment(workspace.id, id, body ?? {});
    return Response.json({ investor });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

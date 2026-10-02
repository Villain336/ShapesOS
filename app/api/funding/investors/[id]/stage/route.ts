// Marketr — Funding/VC slice 2 API.
// POST /api/funding/investors/[id]/stage — move the investor to a new
// pipeline stage. Only legal transitions are accepted; every move is
// recorded as a FundingInteraction (kind stage_change) with the actor.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError, type InvestorStage } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { stage?: string };
    const store = new PrismaFundingStore(prisma);
    const investor = await store.transitionStage(
      workspace.id,
      id,
      body?.stage as InvestorStage,
      user.email ?? "founder",
    );
    return Response.json({ investor });
  } catch (e) {
    if (e instanceof FundingError) {
      const status = e.code === "investor_not_found" ? 404 : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

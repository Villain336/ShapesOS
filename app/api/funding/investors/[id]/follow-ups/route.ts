// Marketr — Funding/VC slice 2 API.
// GET /api/funding/investors/[id]/follow-ups — follow-ups on this investor.
// POST /api/funding/investors/[id]/follow-ups — add a follow-up reminder.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError, type FollowUpInput } from "@/lib/funding/types";

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
    const { followUps } = await store.getInvestorDetail(workspace.id, id);
    return Response.json({ followUps });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as FollowUpInput;
    const store = new PrismaFundingStore(prisma);
    const followUp = await store.createFollowUp(workspace.id, id, body ?? {});
    return Response.json({ followUp }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

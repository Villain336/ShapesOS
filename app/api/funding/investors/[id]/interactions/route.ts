// Marketr — Funding/VC slice 2 API.
// GET /api/funding/investors/[id]/interactions — the interaction timeline.
// POST /api/funding/investors/[id]/interactions — log a typed interaction
// (call, email, meeting, note, ...). stage_change rows are written by the
// stage-transition path only.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError, type InteractionInput } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

function fundingErrorResponse(e: FundingError) {
  const status =
    e.code === "investor_not_found" || e.code === "contact_not_found" ? 404 : 400;
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
    const { interactions } = await store.getInvestorDetail(workspace.id, id);
    return Response.json({ interactions });
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
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as InteractionInput;
    const store = new PrismaFundingStore(prisma);
    const interaction = await store.logInteraction(
      workspace.id,
      id,
      body ?? {},
      user.email ?? "founder",
    );
    return Response.json({ interaction }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

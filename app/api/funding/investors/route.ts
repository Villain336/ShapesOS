// Marketr — Funding/VC slice 2 API.
// GET /api/funding/investors — the tenant's pipeline investors.
// POST /api/funding/investors — add an investor (v1 = manual entry).

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

function fundingErrorResponse(e: FundingError) {
  const status = e.code === "investor_not_found" ? 404 : 400;
  return Response.json({ error: e.message, code: e.code }, { status });
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const investors = await store.listPipelineInvestors(workspace.id);
    return Response.json({ investors });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      name?: string;
      firm?: string | null;
      email?: string | null;
      source?: string | null;
    };
    const store = new PrismaFundingStore(prisma);
    const investor = await store.createInvestor(workspace.id, body ?? {});
    return Response.json({ investor }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
    return httpErrorResponse(e);
  }
}

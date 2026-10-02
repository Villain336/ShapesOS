// Marketr — Funding/VC slice 1 API.
// GET /api/funding/profile — the founder's active raise: target investor
// profile (check size, stages, sectors, thesis).
// POST /api/funding/profile — save the target investor profile (editor
// role). Exactly one active round per tenant.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError, type TargetInvestorProfileInput } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const round = await store.getActiveRound(workspace.id);
    return Response.json({ round });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as TargetInvestorProfileInput;
    const store = new PrismaFundingStore(prisma);
    const round = await store.upsertRound(workspace.id, body);
    return Response.json({ round });
  } catch (e) {
    if (e instanceof FundingError) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    return httpErrorResponse(e);
  }
}

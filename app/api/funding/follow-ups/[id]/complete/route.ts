// Marketr — Funding/VC slice 2 API.
// POST /api/funding/follow-ups/[id]/complete — mark a follow-up done.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaFundingStore(prisma);
    const followUp = await store.completeFollowUp(workspace.id, id);
    return Response.json({ followUp });
  } catch (e) {
    if (e instanceof FundingError) {
      const status = e.code === "followup_not_found" ? 404 : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

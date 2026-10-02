// Marketr — Funding/VC slice 4 API.
// GET /api/funding/rounds/[id]/readiness — the round's readiness checklist
//        (seeded on first read) + computed signals: read-only Legal vault
//        cross-links (formation / EIN docs), data-room state, cap-table
//        rollup, latest deck review. Also ships the SAFE template catalog
//        and the not-advice label (Legal guardrail carries over).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";
import {
  READINESS_CHECKLIST_TEMPLATE,
} from "@/lib/funding/readiness";
import {
  SAFE_TEMPLATES,
  SAFE_NOT_ADVICE_LABEL,
} from "@/lib/funding/safe-templates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaFundingStore(prisma);
    const { items, signals } = await store.getReadiness(workspace.id, id);
    return Response.json({
      workspaceId: workspace.id,
      roundId: id,
      items,
      signals,
      checklistTemplate: READINESS_CHECKLIST_TEMPLATE,
      safeTemplates: SAFE_TEMPLATES,
      notAdviceLabel: SAFE_NOT_ADVICE_LABEL,
    });
  } catch (e) {
    if (e instanceof FundingError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: e.code === "ROUND_NOT_FOUND" ? 404 : 400 },
      );
    }
    return httpErrorResponse(e);
  }
}

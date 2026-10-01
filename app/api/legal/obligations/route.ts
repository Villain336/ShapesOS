// Marketr — Legal/Compliance slice 1 API.
// GET /api/legal/obligations — the tenant's computed obligation checklist,
// per-tenant from their legal profile (never generic).
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER } from "@/lib/legal/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaLegalStore(prisma);
    const profile = await store.getProfile(workspace.id);
    const obligations = await store.listObligations(workspace.id);
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      profile: profile
        ? {
            industry: profile.industry,
            businessModel: profile.businessModel,
            jurisdictions: profile.jurisdictions,
          }
        : null,
      obligations,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

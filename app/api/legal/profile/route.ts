// Marketr — Legal/Compliance slice 1 API.
// GET /api/legal/profile — the tenant's legal profile (null when unset).
// PUT /api/legal/profile — save industry + business model + jurisdictions,
// re-materializing the tenant's obligation rows. Editor role required.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaLegalStore(prisma);
    const profile = await store.getProfile(workspace.id);
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      profile: profile
        ? {
            industry: profile.industry,
            businessModel: profile.businessModel,
            jurisdictions: profile.jurisdictions,
          }
        : null,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      industry?: unknown;
      businessModel?: unknown;
      jurisdictions?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    const { profile, obligations } = await store.saveProfile(workspace.id, {
      industry: typeof body.industry === "string" ? body.industry : "",
      businessModel: typeof body.businessModel === "string" ? body.businessModel : "",
      jurisdictions: Array.isArray(body.jurisdictions)
        ? body.jurisdictions.filter((j): j is string => typeof j === "string")
        : [],
    });
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, profile, obligations });
  } catch (e) {
    if (e instanceof LegalError) {
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status: 400 },
      );
    }
    return httpErrorResponse(e);
  }
}

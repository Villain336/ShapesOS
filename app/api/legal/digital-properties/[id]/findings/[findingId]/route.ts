// Marketr — Legal/Compliance slice 5 API.
// PATCH /api/legal/digital-properties/[id]/findings/[findingId] — move one
// finding through the allowed status transitions
// (open → fixed | dismissed; fixed/dismissed → open). Editor.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import type { DigitalFindingStatus } from "@/lib/legal/digital";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; findingId: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { findingId } = await params;
    const body = (await readJson(req)) as { status?: unknown };
    const store = new PrismaLegalStore(prisma);
    const finding = await store.setDigitalFindingStatus(
      workspace.id,
      findingId,
      body.status as DigitalFindingStatus,
    );
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, finding });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_FINDING" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

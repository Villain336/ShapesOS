// Marketr — Legal/Compliance slice 1 API.
// PATCH /api/legal/obligations/[key] — tenant-controlled status on one
// obligation: open | snoozed | dismissed | done, with optional snoozedUntil
// and note. Editor role required.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError, type ObligationStatus } from "@/lib/legal/types";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { key } = await params;
    const body = (await readJson(req)) as {
      status?: unknown;
      snoozedUntil?: unknown;
      note?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    await store.setObligationStatus(workspace.id, key, body.status as ObligationStatus, {
      snoozedUntil:
        typeof body.snoozedUntil === "string" ? body.snoozedUntil : null,
      note: typeof body.note === "string" ? body.note : null,
    });
    const obligations = await store.listObligations(workspace.id);
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, obligations });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_TEMPLATE" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

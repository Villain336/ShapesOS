// Marketr — Legal/Compliance slice 4 API.
// PATCH /api/legal/radar/[key] — tenant-controlled triage on one change:
// reviewed | dismissed. Editor role required.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import { SEED_FEED_NOTICE } from "@/lib/legal/radar-types";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { key } = await params;
    const body = (await readJson(req)) as { status?: unknown };
    const store = new PrismaLegalStore(prisma);
    const items = await store.setRadarTriage(
      workspace.id,
      key,
      body.status as "reviewed" | "dismissed",
    );
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      seedFeed: true,
      seedFeedNotice: SEED_FEED_NOTICE,
      items,
    });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_CHANGE" ? 404 : 400;
      return Response.json(
        {
          disclaimer: LEGAL_DISCLAIMER,
          seedFeedNotice: SEED_FEED_NOTICE,
          error: e.message,
        },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

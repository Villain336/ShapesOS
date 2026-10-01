// Marketr — Legal/Compliance slice 4 API.
// POST /api/legal/radar/[key]/to-obligation — "add to my obligations":
// materialize a radar change as a tenant obligation, wired into slice 1's
// obligation store (radar-prefixed template + open obligation row). The
// change must triage as relevant to the tenant's profile — "does this affect
// me" gates the conversion. Editor role required.
// Insurance invariant holds: this creates an obligation reminder only.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import { SEED_FEED_NOTICE } from "@/lib/legal/radar-types";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { key } = await params;
    const store = new PrismaLegalStore(prisma);
    const obligation = await store.addChangeToObligations(workspace.id, key);
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      seedFeedNotice: SEED_FEED_NOTICE,
      obligation,
    });
  } catch (e) {
    if (e instanceof LegalError) {
      const status =
        e.code === "UNKNOWN_CHANGE" || e.code === "NO_PROFILE" ? 404 : 400;
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

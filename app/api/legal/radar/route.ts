// Marketr — Legal/Compliance slice 4 API.
// GET /api/legal/radar — the tenant's triaged change radar: every regulation
// change with a relevance verdict for their LegalProfile ("does this affect
// me") plus their reviewed/dismissed triage state merged by key.
// Every response carries the information-not-advice label, and the v1 seed
// feed is labeled as illustrative seed data — never live tracking.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER } from "@/lib/legal/types";
import { SEED_FEED_NOTICE } from "@/lib/legal/radar-types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaLegalStore(prisma);
    const { profile, items } = await store.listRadar(workspace.id);
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      seedFeed: true,
      seedFeedNotice: SEED_FEED_NOTICE,
      profile,
      needsProfile: profile === null,
      items,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

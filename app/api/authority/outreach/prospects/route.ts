// Marketr — O1 GET /api/authority/outreach/prospects (viewer+)
// Query: ?campaignId=&status= (status: new|qualified|contacted|replied|placed|bounced|suppressed|declined)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { outreachStores } from "@/app/api/authority/outreach/_stores";
import type { ProspectStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const STATUSES: ProspectStatus[] = [
  "new", "qualified", "contacted", "replied", "placed", "bounced", "suppressed", "declined",
];

export async function GET(req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ prospects: [], tablesReady: false });
  }
  const url = new URL(req.url);
  const campaignId = url.searchParams.get("campaignId") ?? undefined;
  const statusParam = url.searchParams.get("status") ?? undefined;
  if (statusParam && !(STATUSES as string[]).includes(statusParam)) {
    return badRequest(`Invalid status. Expected one of: ${STATUSES.join(", ")}.`);
  }
  const stores = outreachStores();
  const prospects = await stores.prospects.list(
    gate.workspaceId,
    campaignId,
    statusParam as ProspectStatus | undefined,
  );
  return Response.json({
    prospects: prospects.map((p) => ({
      id: p.id,
      campaignId: p.campaignId,
      domain: p.domain,
      url: p.url,
      contactName: p.contactName,
      emailVerified: p.emailVerified,
      qualityScore: p.qualityScore,
      relevanceScore: p.relevanceScore,
      status: p.status,
      createdAt: p.createdAt,
    })),
  });
}

// Marketr — O1 POST /api/authority/outreach/prospects/:id/qualify (editor+)
// Qualifies a prospect when its combined quality/relevance score meets the
// campaign threshold (default 60). Body: { threshold? }.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { qualifyProspectSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { qualifyProspect } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const { id } = await params;
  const parsed = qualifyProspectSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid qualify input", parsed.error.issues);
  const stores = outreachStores();
  try {
    const prospect = await qualifyProspect(stores.prospects, {
      workspaceId: gate.workspaceId,
      prospectId: id,
      threshold: parsed.data.threshold,
      actor: gate.userId,
    });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "prospect_qualified",
      entityType: "outreach_prospect",
      entityId: prospect.id,
      detail: { campaignId: prospect.campaignId, threshold: parsed.data.threshold },
    });
    return Response.json({ prospect: { id: prospect.id, status: prospect.status, campaignId: prospect.campaignId } });
  } catch (err) {
    return safetyError(err);
  }
}

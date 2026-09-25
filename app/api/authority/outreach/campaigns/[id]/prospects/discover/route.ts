// Marketr — O1 POST /api/authority/outreach/campaigns/:id/prospects/discover (editor+)
// Fixture discovery: fake SERP "write for us" + fake Hunter.io email finding.
// Body: { query, niche }.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { discoverProspectsSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import { discoverProspects } from "@/lib/authority/outreach";
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
  const parsed = discoverProspectsSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid discovery input", parsed.error.issues);
  const stores = outreachStores();
  try {
    const campaign = await stores.campaigns.get(id, gate.workspaceId);
    if (!campaign) return Response.json({ error: "Campaign not found in workspace." }, { status: 404 });
    const prospects = await discoverProspects(stores.prospects, {
      workspaceId: gate.workspaceId,
      campaignId: id,
      query: parsed.data.query,
      niche: parsed.data.niche,
      actor: gate.userId,
    });
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "prospects_discovered",
      entityType: "outreach_campaign",
      entityId: id,
      detail: { query: parsed.data.query, niche: parsed.data.niche, count: prospects.length, mode: "fixture" },
    });
    return Response.json({
      count: prospects.length,
      prospects: prospects.map((p) => ({
        id: p.id,
        domain: p.domain,
        url: p.url,
        contactName: p.contactName,
        emailVerified: p.emailVerified,
        qualityScore: p.qualityScore,
        relevanceScore: p.relevanceScore,
        status: p.status,
      })),
    }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}

// Marketr — O1 /api/authority/outreach/campaigns
// GET  → list campaigns (viewer+)
// POST → create a campaign (editor+). Depth 1–3 ladder config is set here.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { outreachCampaignSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady } from "@/lib/authority/db";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ campaigns: [], tablesReady: false });
  }
  const stores = outreachStores();
  const campaigns = await stores.campaigns.list(gate.workspaceId);
  return Response.json({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      depth: c.depth,
      status: c.status,
      sendingDomainId: c.sendingDomainId,
      dailyCap: c.dailyCap,
      warmupVerifiedAt: c.warmupVerifiedAt,
      approvalId: c.approvalId,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const parsed = outreachCampaignSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid campaign input", parsed.error.issues);
  const stores = outreachStores();
  try {
    if (parsed.data.sendingDomainId) {
      const domain = await stores.domains.get(parsed.data.sendingDomainId, gate.workspaceId);
      if (!domain) return Response.json({ error: "Sending domain not found in workspace." }, { status: 404 });
    }
    const campaign = await stores.campaigns.create(gate.workspaceId, {
      name: parsed.data.name,
      depth: parsed.data.depth,
      sendingDomainId: parsed.data.sendingDomainId,
      dailyCap: parsed.data.dailyCap,
      createdBy: gate.userId,
    });
    return Response.json({ campaign }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}

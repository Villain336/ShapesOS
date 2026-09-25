// Marketr — O1 GET /api/authority/outreach/campaigns/:id
// Single campaign with its sending domain, the depth-3 enablement checklist
// evaluated live against that domain, and any pending depth3_activation
// approval (viewer+).

import { authorityGuard } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";
import { evaluateDomain } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ campaign: null, tablesReady: false });
  }
  const { id } = await params;
  const stores = outreachStores();
  const campaign = await stores.campaigns.get(id, gate.workspaceId);
  if (!campaign) return Response.json({ error: "Campaign not found in workspace." }, { status: 404 });

  const domain = campaign.sendingDomainId
    ? await stores.domains.get(campaign.sendingDomainId, gate.workspaceId)
    : null;
  const checklist = domain
    ? (() => {
        const { failures, ready } = evaluateDomain(domain);
        return { passed: ready, failures };
      })()
    : null;

  let pendingApproval = null;
  if (campaign.depth === 3 && campaign.status !== "active") {
    const approvals = await authorityApprovals.list(gate.workspaceId, "pending", 20);
    const match = approvals.find(
      (a) => a.type === "depth3_activation" && (a.bindingJson as { campaignId?: string }).campaignId === campaign.id,
    );
    if (match) {
      pendingApproval = {
        id: match.id,
        status: match.status,
        approvers: match.approvers,
        twoPersonRequired: match.twoPersonRequired,
        createdBy: match.createdBy,
        createdAt: match.createdAt,
      };
    }
  }

  return Response.json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      depth: campaign.depth,
      status: campaign.status,
      sendingDomainId: campaign.sendingDomainId,
      dailyCap: campaign.dailyCap,
      warmupVerifiedAt: campaign.warmupVerifiedAt,
      approvalId: campaign.approvalId,
      createdBy: campaign.createdBy,
      createdAt: campaign.createdAt,
    },
    sendingDomain: domain
      ? { id: domain.id, domain: domain.domain, isPrimary: domain.isPrimary, status: domain.status }
      : null,
    depth3Checklist: checklist,
    pendingApproval,
  });
}

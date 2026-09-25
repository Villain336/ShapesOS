// Marketr — O1 POST /api/authority/outreach/campaigns/:id/activate (editor+)
//
// Depth 1/2: flips draft -> active (no sends; depth 1 has zero sending code
// paths, depth 2 sends only via human click + per-send approval).
// Depth 3:
//   - dryRun=true  → run the depth-3 enablement checklist without mutating,
//     return each item pass/fail.
//   - no approvalId → run the checklist (ANY failure → 422 naming the missing
//     items), then create + submit a depth3_activation AuthorityApproval and
//     return it pending (HTTP 202). Activation completes only after two
//     distinct approvers approve it.
//   - approvalId   → finalize against the approved two-person approval
//     (checklist re-run, binding re-verified, approval executed) and flip
//     the campaign active.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { activateCampaignSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady } from "@/lib/authority/db";
import {
  activateShallowCampaign, requestDepth3Activation, finalizeDepth3Activation,
  evaluateDomain,
} from "@/lib/authority/outreach";
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
  const parsed = activateCampaignSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid activation input", parsed.error.issues);
  const { dryRun, sendingDomainId, approvalId } = parsed.data;
  const stores = outreachStores();

  try {
    const campaign = await stores.campaigns.get(id, gate.workspaceId);
    if (!campaign) return Response.json({ error: "Campaign not found in workspace." }, { status: 404 });

    if (campaign.depth !== 3) {
      if (approvalId) {
        return badRequest("Approvals are only used for depth-3 activation.");
      }
      const updated = await activateShallowCampaign(stores, {
        workspaceId: gate.workspaceId,
        campaignId: id,
        actor: gate.userId,
      });
      return Response.json({ campaign: updated });
    }

    // --- Depth 3 ---
    if (dryRun) {
      const domainId = sendingDomainId ?? campaign.sendingDomainId;
      if (!domainId) {
        return Response.json(
          {
            passed: false,
            failures: [{ code: "no_sending_domain", message: "A sending domain is required for depth-3 activation." }],
          },
          { status: 200 },
        );
      }
      const domain = await stores.domains.get(domainId, gate.workspaceId);
      if (!domain) return Response.json({ error: "Sending domain not found in workspace." }, { status: 404 });
      const { failures, ready } = evaluateDomain(domain);
      return Response.json({ passed: ready, failures, domainId: domain.id, domain: domain.domain });
    }

    if (approvalId) {
      const result = await finalizeDepth3Activation(stores, {
        workspaceId: gate.workspaceId,
        campaignId: id,
        approvalId,
        actor: gate.userId,
      });
      return Response.json({
        campaign: result.campaign,
        checklist: result.checklist,
        approval: result.approval,
      });
    }

    const result = await requestDepth3Activation(stores, {
      workspaceId: gate.workspaceId,
      campaignId: id,
      sendingDomainId,
      actor: gate.userId,
    });
    return Response.json(
      {
        campaign: result.campaign,
        checklist: result.checklist,
        approval: {
          id: result.approval.id,
          status: result.approval.status,
          type: result.approval.type,
          twoPersonRequired: result.approval.twoPersonRequired,
          approvers: result.approval.approvers,
        },
        message: "Depth-3 checklist passed. Activation approval is pending two distinct approvers — activation completes only after both approve.",
      },
      { status: 202 },
    );
  } catch (err) {
    return safetyError(err);
  }
}

// Marketr — Wave 2 Insurance slice 3a/3c: pending governed approvals API.
// GET /api/insurance/governance/pending[?action=bind_policy] — list pending
// insurance governed approvals for the workspace (editor role). Optional
// action filter.
//
// Slice 3c: the response also carries the workspace's appointed licensed
// partner (name + producer license number), so a bind reviewer can see WHO
// the licensed rail's producer of record is. The partner lookup is
// fail-safe: a workspace with no appointed partner still sees its pending
// queue (partner: null) — the bind gate (PARTNER_NOT_APPOINTED) applies at
// execution time, never at review time.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import { getPendingApprovals } from "@/lib/insurance/governance";
import {
  requireAppointedPartner,
  prismaLicensedPartnerStore,
} from "@/lib/insurance/partner";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") ?? undefined;

    const approvals = await getPendingApprovals(workspace.id, action);

    let appointedPartner: Record<string, unknown> | null = null;
    try {
      const p = await requireAppointedPartner(
        workspace.id,
        prismaLicensedPartnerStore(),
      );
      appointedPartner = {
        name: p.name,
        licenseNumber: p.licenseNumber,
        licensedStates: p.statesLicensed,
        appointmentPath: p.appointmentPath,
      };
    } catch (e) {
      if (e instanceof InsuranceError && e.code === "PARTNER_NOT_APPOINTED") {
        appointedPartner = null;
      } else {
        throw e;
      }
    }

    return Response.json({
      approvals: approvals.map((a) => ({
        id: a.id,
        kind: a.kind,
        payload: a.payload,
        status: a.status,
        requestedBy: a.requestedBy,
        createdAt: a.createdAt ? a.createdAt.toISOString() : null,
      })),
      appointedPartner,
    });
  } catch (e) {
    if (e instanceof InsuranceError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return httpErrorResponse(e);
  }
}

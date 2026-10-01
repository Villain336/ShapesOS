// Marketr — Wave 2 Insurance slice 3c: licensed-partner update API.
// PATCH /api/insurance/partners/[id] — status (active/suspended/revoked) or
// licensed-states update. Status changes are owner/admin-gated: suspending or
// revoking a partner cuts the bind gate for the whole workspace (fail closed
// at the gate), so this is an admin-level act. Licensed-states edits are
// editor-gated.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, HttpError } from "@/lib/enrichment/guard";
import { requireWorkspaceRole } from "@/lib/authz";
import { InsuranceError } from "@/lib/insurance/types";
import {
  prismaLicensedPartnerStore,
  serializePartner,
  validatePartnerStates,
} from "@/lib/insurance/partner";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  status: z.enum(["active", "suspended", "revoked"]).optional(),
  licensedStates: z.array(z.string().trim().min(1).max(10)).min(1).max(60).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = PatchSchema.parse(await req.json());
    if (body.status === undefined && body.licensedStates === undefined) {
      return Response.json(
        { error: "Nothing to update: provide status and/or licensedStates.", code: "BAD_PARTNER_INPUT" },
        { status: 400 },
      );
    }

    const store = prismaLicensedPartnerStore();

    // Status changes are admin-gated — they flip the bind gate for the workspace.
    if (body.status !== undefined) {
      if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) {
        throw new HttpError(403, "Partner status changes require an admin.");
      }
      // Fail closed on re-activation: an "active" partner must carry license
      // identity (license number + states), or it can never satisfy the gate.
      if (body.status === "active") {
        const existing = await store.get(workspace.id, id);
        if (!existing) {
          throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
        }
        const states =
          body.licensedStates !== undefined
            ? validatePartnerStates(body.licensedStates)
            : existing.statesLicensed;
        if (!existing.licenseNumber || existing.licenseNumber.trim().length === 0) {
          throw new InsuranceError(
            "PARTNER_LICENSE_REQUIRED",
            "Cannot activate: this partner has no producer license number on file.",
          );
        }
        if (states.length === 0) {
          throw new InsuranceError(
            "PARTNER_STATES_REQUIRED",
            "Cannot activate: this partner has no licensed states on file.",
          );
        }
      }
      await store.setStatus(workspace.id, id, body.status);
    }

    if (body.licensedStates !== undefined) {
      await store.setLicensedStates(workspace.id, id, body.licensedStates);
    }

    const partner = await store.get(workspace.id, id);
    if (!partner) {
      throw new InsuranceError("UNKNOWN_PARTNER", "Licensed partner not found in this workspace.");
    }
    return Response.json({ partner: serializePartner(partner) });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        {
          error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          code: "BAD_PARTNER_INPUT",
        },
        { status: 400 },
      );
    }
    if (e instanceof InsuranceError) {
      const status =
        e.code === "UNKNOWN_PARTNER"
          ? 404
          : e.code === "BAD_PARTNER_INPUT"
            ? 400
            : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

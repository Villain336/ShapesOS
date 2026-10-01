// Marketr — Wave 2 Insurance slice 3c: licensed-partner management API.
// GET  /api/insurance/partners — workspace-scoped partner list (any member).
// POST /api/insurance/partners — register a partner (editor role). Fail
// closed: name, producer license number, and licensed states are required;
// a partner without license identity can never satisfy the bind gate.
// This is the write path the bind gate needs: until a partner is registered
// here, PARTNER_NOT_APPOINTED blocks every bind execution.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import {
  prismaLicensedPartnerStore,
  serializePartner,
} from "@/lib/insurance/partner";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  producerLicenseNumber: z.string().trim().min(1).max(100),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal("")),
  licensedStates: z.array(z.string().trim().min(1).max(10)).min(1).max(60),
  appointmentPath: z.enum(["direct", "dais_market_access", "subappointment"]),
  notes: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = prismaLicensedPartnerStore();
    const partners = await store.list(workspace.id);
    return Response.json({ partners: partners.map(serializePartner) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = CreateSchema.parse(await req.json());

    const store = prismaLicensedPartnerStore();
    const partner = await store.create(workspace.id, {
      name: body.name,
      contactEmail: body.contactEmail || undefined,
      licenseNumber: body.producerLicenseNumber,
      statesLicensed: body.licensedStates,
      appointmentPath: body.appointmentPath,
      notes: body.notes || undefined,
    });

    return Response.json(
      { partner: serializePartner(partner), createdBy: user.id },
      { status: 201 },
    );
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
      // validatePartnerInput fail-closed codes → 422 with the named code.
      return Response.json({ error: e.message, code: e.code }, { status: 422 });
    }
    return httpErrorResponse(e);
  }
}

// Marketr — Wave 2 Insurance slice 5: revoke an issued certificate.
// POST /api/insurance/certificates/[id]/revoke — editor role. issued →
// revoked with a required reason + audit event. The PDF artifact stays in
// the DB but the /pdf endpoint serves it as revoked (410).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import {
  revokeCertificate,
  serializeCertificate,
} from "@/lib/insurance/certificates";

export const dynamic = "force-dynamic";

const RevokeSchema = z.object({
  reason: z.string().trim().min(1).max(2000),
});

function certErrorStatus(code: string): number {
  if (code === "CERT_NOT_FOUND") return 404;
  if (code === "CERT_INVALID_CERT_STATUS") return 409;
  return 422;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = RevokeSchema.parse(await req.json());

    const certificate = await revokeCertificate(
      workspace.id,
      id,
      user.id,
      body.reason,
    );

    return Response.json({ certificate: serializeCertificate(certificate) });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }
    if (e instanceof InsuranceError) {
      return Response.json(
        { error: e.message, code: e.code },
        { status: certErrorStatus(e.code) },
      );
    }
    return httpErrorResponse(e);
  }
}

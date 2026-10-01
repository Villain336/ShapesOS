// Marketr — Wave 2 Insurance slice 5: issue a prepared certificate.
// POST /api/insurance/certificates/[id]/issue — editor role. Requires an
// APPROVED issue_certificate approval (body.approvalId); the approval
// payload is re-verified against the draft and the live policy row before
// any PDF is rendered (disclosure drift fails closed). Generates the
// ACORD-25-style PDF from the verified payload, stores bytes + sha256,
// marks the certificate issued, and writes the audit record.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import {
  issueCertificate,
  serializeCertificate,
} from "@/lib/insurance/certificates";

export const dynamic = "force-dynamic";

const IssueSchema = z.object({
  approvalId: z.string().trim().min(1).max(100),
});

function certErrorStatus(code: string): number {
  if (
    code === "CERT_POLICY_NOT_FOUND" ||
    code === "CERT_NOT_FOUND" ||
    code === "CERT_APPROVAL_NOT_FOUND"
  ) {
    return 404;
  }
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
    const body = IssueSchema.parse(await req.json());

    const { certificate, pdfHash } = await issueCertificate(
      workspace.id,
      id,
      body.approvalId,
      user.id,
    );

    return Response.json({
      certificate: serializeCertificate(certificate),
      pdfHash,
      pdfUrl: `/api/insurance/certificates/${certificate.id}/pdf`,
    });
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

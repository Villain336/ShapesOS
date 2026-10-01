// Marketr — Wave 2 Insurance slice 5: certificate of insurance API.
// GET  /api/insurance/certificates — list certificates with policy + approval
//        state (editor role).
// POST /api/insurance/certificates — PREPARE a certificate (editor role):
//        the agent prepares a draft from in-force policy truth and proposes
//        the issue_certificate governed action for human review. Nothing is
//        issued here — issuance requires the separate /issue endpoint with an
//        approved approval.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError, LINE_LABELS } from "@/lib/insurance/types";
import {
  prepareCertificate,
  serializeCertificate,
} from "@/lib/insurance/certificates";

export const dynamic = "force-dynamic";

const PrepareSchema = z.object({
  policyId: z.string().trim().min(1).max(100),
  holderName: z.string().trim().min(1).max(200),
  holderAddress: z.string().trim().max(500).nullable().optional(),
  additionalInsured: z.boolean().optional(),
  waiverOfSubrogation: z.boolean().optional(),
  operationsDescription: z.string().trim().max(2000).nullable().optional(),
  /** Who requested this COI (agent or human actor). */
  requestedBy: z.string().trim().max(200).optional(),
  /** Contract / client reference that requires the COI. */
  requestedFor: z.string().trim().max(500).optional(),
  validFrom: z.string().datetime({ offset: true }).optional(),
  validTo: z.string().datetime({ offset: true }).optional(),
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

export async function GET() {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const certs = await prisma.insuranceCertificate.findMany({
      where: { workspaceId: workspace.id },
      include: { policy: { include: { carrier: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
    });
    const approvalIds = certs.map((c) => c.approvalId).filter((a): a is string => !!a);
    const approvals = approvalIds.length
      ? await prisma.approvalItem.findMany({
          where: { workspaceId: workspace.id, id: { in: approvalIds } },
          select: { id: true, status: true, payload: true },
        })
      : [];
    const approvalById = new Map(approvals.map((a) => [a.id, a]));
    return Response.json({
      certificates: certs.map((c) =>
        serializeCertificate(
          {
            id: c.id,
            workspaceId: c.workspaceId,
            policyId: c.policyId,
            holderName: c.holderName,
            holderAddress: c.holderAddress,
            additionalInsured: c.additionalInsured,
            waiverOfSubrogation: c.waiverOfSubrogation,
            operationsDescription: c.operationsDescription,
            issueDate: c.issueDate,
            validFrom: c.validFrom,
            validTo: c.validTo,
            status: c.status as "draft" | "issued" | "revoked",
            requestedBy: c.requestedBy,
            requestedFor: c.requestedFor,
            issuedBy: c.issuedBy,
            issuedAt: c.issuedAt,
            approvalId: c.approvalId,
            pdfHash: c.pdfHash,
            revokedReason: c.revokedReason,
            revokedAt: c.revokedAt,
            revokedBy: c.revokedBy,
          },
          {
            policyNumber: c.policy.policyNumber,
            carrierName: c.policy.carrier.name,
            lineLabel: LINE_LABELS[c.policy.line as keyof typeof LINE_LABELS] ?? c.policy.line,
            approvalStatus: c.approvalId ? (approvalById.get(c.approvalId)?.status ?? null) : null,
            approvalPayload: c.approvalId
              ? ((approvalById.get(c.approvalId)?.payload ?? null) as Record<string, unknown> | null)
              : null,
          },
        ),
      ),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = PrepareSchema.parse(await req.json());

    const { certificate, approval, payload } = await prepareCertificate(
      workspace.id,
      {
        policyId: body.policyId,
        holderName: body.holderName,
        holderAddress: body.holderAddress ?? null,
        additionalInsured: body.additionalInsured ?? false,
        waiverOfSubrogation: body.waiverOfSubrogation ?? false,
        operationsDescription: body.operationsDescription ?? null,
        requestedBy: body.requestedBy ?? user.id,
        requestedFor: body.requestedFor ?? undefined,
        validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
        validTo: body.validTo ? new Date(body.validTo) : undefined,
      },
    );

    return Response.json(
      {
        certificateId: certificate.id,
        status: certificate.status,
        approvalId: approval.id,
        approvalKind: approval.kind,
        payload,
        reviewAt: "/api/insurance/governance/pending?action=issue_certificate",
      },
      { status: 201 },
    );
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

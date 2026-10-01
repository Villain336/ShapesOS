// Marketr — Wave 2 Insurance slice 3a: governed-action decision API.
// POST /api/insurance/governance/[id]/decide — approve or reject a pending
// governed action, editor role. Every decision (approved or denied) writes an
// InsuranceAuditEvent (who/what/timestamp). Execution stays on the licensed
// rail after approval; the audit's vendorTransactionRef fills in then.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import { decideGovernedAction } from "@/lib/insurance/governance";

export const dynamic = "force-dynamic";

const DecideSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  decidedBy: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = DecideSchema.parse(await req.json());

    const { approval, audit } = await decideGovernedAction(
      id,
      workspace.id,
      body.decision,
      body.decidedBy ?? user.id,
      body.note,
    );

    return Response.json({
      approval: {
        id: approval.id,
        kind: approval.kind,
        status: approval.status,
        decidedBy: approval.decidedBy,
        decidedAt: approval.decidedAt?.toISOString() ?? null,
        note: approval.note,
      },
      audit: {
        id: audit.id,
        action: audit.action,
        subjectType: audit.subjectType,
        subjectId: audit.subjectId,
        result: audit.result,
        decidedBy: audit.decidedBy,
        decidedAt: audit.decidedAt.toISOString(),
        vendorTransactionRef: audit.vendorTransactionRef,
      },
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }
    if (e instanceof InsuranceError) {
      const status =
        e.code === "APPROVAL_NOT_FOUND" ? 404 : e.code === "APPROVAL_NOT_PENDING" ? 409 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

// Marketr — R6 "send to sequence" export approval.
// POST /api/prospects/export-approval (editor) { prospectIds[], sequenceId }
//   → creates an ApprovalItem (kind "prospect_export"). R3's sequences agent
//   owns execution; this endpoint only queues the approval.
//
// NO AUTONOMOUS SENDING, EVER. The approval item is the gate: nothing leaves
// Marketr until a human approves it in the R3 approval queue, where the
// consent layer (opt-in / legitimate-interest review) is enforced.
// Cold-email compliance (CAN-SPAM): the UI surfaces a compliance warning
// before export; enforcement lives in R3's consent layer.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson, HttpError } from "@/lib/enrichment/guard";

const Schema = z.object({
  prospectIds: z.array(z.string().min(1)).min(1).max(1000),
  sequenceId: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const { prospectIds, sequenceId } = parsed.data;

    const sequence = await prisma.nurtureSequence.findFirst({
      where: { id: sequenceId, workspaceId: workspace.id },
      select: { id: true, name: true, status: true },
    });
    if (!sequence) throw new HttpError(404, "Sequence not found");

    const prospects = await prisma.prospect.findMany({
      where: { id: { in: prospectIds }, workspaceId: workspace.id },
      select: { id: true, email: true, status: true },
    });
    if (prospects.length === 0) throw new HttpError(400, "No matching prospects in this workspace");
    const missingEmails = prospects.filter((p) => !p.email).length;

    const item = await prisma.approvalItem.create({
      data: {
        workspaceId: workspace.id,
        kind: "prospect_export",
        payload: {
          prospectIds: prospects.map((p) => p.id),
          sequenceId: sequence.id,
          sequenceName: sequence.name,
          requestedAt: new Date().toISOString(),
          compliance: {
            warning:
              "Cold outreach requires CAN-SPAM compliance: every recipient must have " +
              "opted in or qualify under legitimate interest, and every message must " +
              "include a working unsubscribe mechanism and the sender's physical address. " +
              "Consent review is enforced in R3's sequence consent layer before any send.",
            missingEmailCount: missingEmails,
          },
        },
        requestedBy: user.id,
        status: "pending",
      },
    });

    return Response.json(
      {
        approval: { id: item.id, kind: item.kind, status: item.status },
        queued: prospects.length,
        missingEmails,
        complianceWarning:
          "Queued for human approval — nothing will be sent until approved. " +
          "Cold outreach requires CAN-SPAM compliance (opt-in or legitimate interest, " +
          "unsubscribe link, sender address). Consent is enforced in R3's sequence layer.",
      },
      { status: 201 },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}

// Marketr — Wave 2 Insurance slice 4: start a renewal remarket.
// POST /api/insurance/renewals/[id]/remarket — create the remarket
// submission pre-filled from the expiring policy, behind the request_quote
// governed action (editor role).
//
// Body: { state?: "NC" } — the risk's 2-letter state. Required: the expiring
// policy does not record one and the OS never invents it (RENEWAL_STATE_REQUIRED).
//
// Returns the renewal, the draft submission, and either the proposed
// request_quote approval or standingRuleCovered: true when a standing quote
// rule pre-approved this line of business.

import { z } from "zod";
import { guardWorkspace } from "@/lib/enrichment/guard";
import { startRemarket } from "@/lib/insurance/renewals";
import {
  serializeRenewal,
  renewalErrorResponse,
} from "../../_shared";

export const dynamic = "force-dynamic";

const RemarketSchema = z.object({
  state: z.string().trim().max(2).optional(),
});

function serializeApproval(
  a: { id: string; kind: string; status: string; requestedBy: string | null } | null,
) {
  if (!a) return null;
  return { id: a.id, kind: a.kind, status: a.status, requestedBy: a.requestedBy };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = RemarketSchema.parse(await req.json());

    const result = await startRemarket(workspace.id, id, user.id, {
      state: body.state,
    });

    return Response.json(
      {
        renewal: serializeRenewal(result.renewal),
        submission: {
          id: result.submission.id,
          status: result.submission.status,
          line: result.submission.line,
          applicantName: result.submission.applicantName,
          state: result.submission.state,
        },
        approval: serializeApproval(result.approval),
        standingRuleCovered: result.standingRuleCovered,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        {
          error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }
    return renewalErrorResponse(e);
  }
}

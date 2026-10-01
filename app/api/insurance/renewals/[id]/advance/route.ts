// Marketr — Wave 2 Insurance slice 4: advance a renewal's remarket state.
// POST /api/insurance/renewals/[id]/advance — move the renewal through the
// remarket machine (editor role). Fail closed on illegal transitions.
//
// Body: { toStatus: "remarketing" | "quoted" | "bound" }.
// - "quoted": pulls the linked submission's quotes (gated: standing rule or
//   an approved request_quote approval) and records the premium delta vs the
//   prior term. The delta flag is visible in the response before any renewal
//   approval.
// - "bound": requires one of the linked submission's quotes to actually be
//   bound through the approvals flow (BIND_APPROVAL_REQUIRED otherwise).
// - "auto_renew_surfaced" is refused here — it requires the carrier's terms
//   via /surface-auto-renew, never a bare transition.

import { z } from "zod";
import { guardWorkspace } from "@/lib/enrichment/guard";
import { advanceRemarket, prismaRenewalStore } from "@/lib/insurance/renewals";
import {
  serializeRenewal,
  renewalErrorResponse,
} from "../../_shared";

export const dynamic = "force-dynamic";

const AdvanceSchema = z.object({
  toStatus: z.string().trim().min(1).max(40),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = AdvanceSchema.parse(await req.json());

    const renewal = await advanceRemarket(
      workspace.id,
      id,
      body.toStatus,
      user.id,
    );

    // When quotes were just recorded, surface them with the renewal so the
    // UI can show the delta badge immediately.
    let submission: {
      id: string;
      status: string;
      quotes: Array<{
        id: string;
        carrierName: string;
        quotedPremiumCents: number | null;
        status: string;
      }>;
    } | null = null;
    if (renewal.remarketStatus === "quoted") {
      const store = prismaRenewalStore();
      const sub = await store.findSubmissionForRenewal(id, workspace.id);
      if (sub) {
        const quotes = await store.listQuotesBySubmission(sub.id, workspace.id);
        submission = {
          id: sub.id,
          status: sub.status,
          quotes: quotes.map((q) => ({
            id: q.id,
            carrierName: q.carrierName,
            quotedPremiumCents: q.quotedPremiumCents,
            status: q.status,
          })),
        };
      }
    }

    return Response.json({
      renewal: serializeRenewal(renewal),
      submission,
    });
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

// Marketr — O1 POST /api/authority/outreach/sequences/:id/draft (editor+)
//
// NOTE on the route shape: a draft sequence does not exist before it is
// drafted, so `:id` here is the PROSPECT id the draft is created for.
// Body: { campaignId, subject, body, unsubscribeUrl, physicalAddress, followups? }.
// Depth 1 throws (prospecting only — zero sending code paths). Drafts expire
// 14 days after creation if unsent. Every template needs a one-click
// unsubscribe URL and a physical address (CAN-SPAM).

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { draftSequenceSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady } from "@/lib/authority/db";
import { createDraft, isDraftExpired, DRAFT_EXPIRY_DAYS } from "@/lib/authority/outreach";
import { outreachStores } from "@/app/api/authority/outreach/_stores";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const { id: prospectId } = await params;
  const parsed = draftSequenceSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid draft input", parsed.error.issues);
  const stores = outreachStores();
  try {
    const seq = await createDraft(stores, {
      workspaceId: gate.workspaceId,
      campaignId: parsed.data.campaignId,
      prospectId,
      subject: parsed.data.subject,
      body: parsed.data.body,
      unsubscribeUrl: parsed.data.unsubscribeUrl,
      physicalAddress: parsed.data.physicalAddress,
      followups: parsed.data.followups,
      createdBy: gate.userId,
    });
    return Response.json(
      {
        sequence: {
          id: seq.id,
          campaignId: seq.campaignId,
          prospectId: seq.prospectId,
          depth: seq.depth,
          status: seq.status,
          steps: seq.stepsJson,
          expiresInDays: DRAFT_EXPIRY_DAYS,
          expired: isDraftExpired(seq.createdAt),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return safetyError(err);
  }
}

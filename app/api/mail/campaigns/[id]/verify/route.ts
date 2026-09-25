// Marketr — POST /api/mail/campaigns/[id]/verify
//
// Run address verification on all pending pieces. Unverifiable addresses are
// quarantined — never silently mailed. On Lob this is a PAID add-on; the
// cost is part of the approved estimate (see /estimate).

import type { NextRequest } from "next/server";
import { mailGuard, badRequest } from "../../../_lib";
import { verifyAddresses } from "@/lib/mail/service";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await mailGuard("editor");
  if (gate instanceof Response) return gate;
  const { id } = await params;

  try {
    const result = await verifyAddresses(gate.workspaceId, id);
    return Response.json({ ...result, campaignId: id });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Verification failed");
  }
}

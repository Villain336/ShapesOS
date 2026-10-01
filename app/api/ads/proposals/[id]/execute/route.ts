// Marketr — Phase 18 slice 2: execute an approved spend proposal.
// POST /api/ads/proposals/:id/execute → runs the approved action against
// the platform API through the spend gate. Editor+ only. The gate refuses
// anything that is not approved, already executed, or scope-mismatched.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { executeSpendProposal } from "@/lib/adplatforms/execute";
import { AdsGateError } from "@/lib/adplatforms/gate";
import { AdsActionError } from "@/lib/adplatforms/actions";
import { AmazonAdsError } from "@/lib/adplatforms/amazon/client";
import { AmazonTokenError } from "@/lib/adplatforms/amazon/tokens";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  try {
    const result = await executeSpendProposal(workspace.id, user.id, id);
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof AdsGateError || e instanceof AdsActionError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    if (e instanceof AmazonTokenError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409 });
    }
    if (e instanceof AmazonAdsError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 502 });
    }
    console.error("[ads/proposals/execute] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Execution failed" }, { status: 500 });
  }
}

// Marketr — /api/authority/approvals
// The generic approval spine for the whole Authority phase (O1 depth-3
// activation, R1 review-reply posts, A1 AEO content fixes, …).
// GET → list approvals for this workspace, ?status=&type= (viewer+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest } from "@/app/api/authority/_lib";
import { authorityTablesReady, authorityApprovals } from "@/lib/authority/db";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "pending", "approved", "approval_rejected", "executed", "expired", "revoked"] as const;
const TYPES = [
  "outreach_send",
  "depth3_activation",
  "pr_send",
  "listing_edit",
  "review_reply_post",
  "aeo_content_fix",
] as const;

export async function GET(req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ approvals: [], tablesReady: false });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return badRequest(`Invalid status. Expected one of: ${STATUSES.join(", ")}.`);
  }
  if (type && !(TYPES as readonly string[]).includes(type)) {
    return badRequest(`Invalid type. Expected one of: ${TYPES.join(", ")}.`);
  }
  const approvals = await authorityApprovals.list(
    gate.workspaceId,
    status as (typeof STATUSES)[number] | undefined,
    100,
  );
  const filtered = type ? approvals.filter((a) => a.type === type) : approvals;
  return Response.json({
    approvals: filtered.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      bindingJson: a.bindingJson,
      approvers: a.approvers,
      twoPersonRequired: a.twoPersonRequired,
      decidedAt: a.decidedAt,
      executedAt: a.executedAt,
      createdBy: a.createdBy,
      createdAt: a.createdAt,
    })),
  });
}

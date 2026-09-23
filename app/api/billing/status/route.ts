// Marketr — billing status for the Settings → Usage page.
// GET /api/billing/status?workspaceId= → { configured, autoOverage, overageRate,
//   packs, purchases, overage }
// Admin-only. Never exposes keys, secrets, modes, or card data — only whether
// purchases are enabled, whether a card is on file, accrued overage, and invoices.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { getBillingStatus, getTopUpHistory, getOverageState } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  const [status, purchases, overage] = await Promise.all([
    getBillingStatus(access.workspaceId),
    getTopUpHistory(access.workspaceId),
    getOverageState(access.workspaceId),
  ]);
  return Response.json({ ...status, purchases, overage });
}

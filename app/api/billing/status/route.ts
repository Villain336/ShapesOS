// Marketr — billing status for the Settings → Usage page.
// GET /api/billing/status?workspaceId= → { configured, autoOverage, overageRate, packs, purchases }
// Admin-only. Never exposes keys, secrets, or modes — only whether
// purchases are enabled.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { getBillingStatus, getTopUpHistory } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  const [status, purchases] = await Promise.all([
    getBillingStatus(access.workspaceId),
    getTopUpHistory(access.workspaceId),
  ]);
  return Response.json({ ...status, purchases });
}

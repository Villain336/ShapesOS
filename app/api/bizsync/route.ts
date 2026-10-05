// ShapesOS — Phase 11 (bizsync): Settings → Connectors → Business sync status.
// GET /api/bizsync?workspaceId= → { providers: ProviderStatus[] }
//   Admin+ (same as the Connectors settings page). Reads only: connection,
//   mapped-object counts, recent runs + last error, export ledger counts,
//   Xero organisations. Never returns credentials.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { workspaceIdFrom, badRequest } from "@/lib/route-utils";
import { bizSyncStatus } from "@/lib/bizsync/status";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspaceId = workspaceIdFrom(req);
  if (!workspaceId) return badRequest("workspaceId is required");
  if (!(await requireWorkspaceRole(user.id, workspaceId, "admin"))) return forbidden("Admin role required.");
  return Response.json({ providers: await bizSyncStatus(workspaceId) });
}

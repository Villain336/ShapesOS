// Marketr — nurture sequence cron tick.
// POST /api/cron/nurture → advanceEnrollments()
//
// Auth: shared cron gate (lib/cron/gate.ts).
//   1. CRON_SECRET service call — advances enrollments across ALL workspaces.
//      Schedule every few minutes (see DEPLOY.md) so sequence steps land on time.
//   2. Signed-in session (editor+) — advances only the caller's workspace,
//      e.g. to "run now" from the dashboard.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { advanceEnrollments } from "@/lib/messaging/sequences";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const result = await advanceEnrollments(isCron ? undefined : sessionWorkspaceId ?? undefined);
  return Response.json({
    ok: true,
    scope: isCron ? "all" : "workspace",
    workspaceId: isCron ? null : sessionWorkspaceId,
    ...result,
  });
}

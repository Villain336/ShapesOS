// Marketr — Phase 14: approval expiry sweep.
// POST /api/cron/actions — expires pending approvals past their TTL.
// Auth: shared cron gate (lib/cron/gate.ts): CRON_SECRET service call, or
// signed-in editor+ session scoped to their workspace.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { expireStaleApprovals } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const expired = await expireStaleApprovals(gate.workspaceId ?? undefined);
  return Response.json({ ok: true, expired });
}

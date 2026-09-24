// Marketr — POST /api/cron/messaging
//
// Dispatch sweep: sends every queued, due, approved message (consent,
// quiet-hours, daily cap, and approval status re-checked per row).
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Cron: Authorization: Bearer <CRON_SECRET> — all workspaces.
//   2. Signed-in session (editor+) — the user's workspace only.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { dispatchDue } from "@/lib/messaging/dispatcher";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const result = await dispatchDue(isCron ? undefined : sessionWorkspaceId!);
  return Response.json({ ...result, workspaceId: sessionWorkspaceId ?? null });
}

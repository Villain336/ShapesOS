// ShapesOS — Phase 18.1 (WS=desk): the desk sweep.
// POST /api/cron/desk
//
// 1. Focus / do not disturb: delivers the notifications focus queued for
//    everyone whose focus has ended (held rows released, pushes sent) — so a
//    member who closed the app still gets them when focus ends.
// 2. The "Today" briefing: every opted-in member whose local morning has
//    come and who has no briefing for today yet gets one, written once
//    (lib/desktop/briefing.server.ts; background workload / Batch API,
//    metered). Bounded by DESK_BRIEFING_MAX_MEMBERS (default 500) per run.
//
// Auth: the shared cron gate (lib/cron/gate.ts) — CRON_SECRET for the
// scheduler (every workspace), or a signed-in editor+ (their workspace only).
// Schedule: every 15 minutes (lib/cron/jobs.ts "desk").

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { releaseEndedFocus } from "@/lib/desktop/focus.server";
import { runBriefingSweep } from "@/lib/desktop/briefing.server";

export const dynamic = "force-dynamic";

function maxMembers(): number {
  const n = Number.parseInt(process.env.DESK_BRIEFING_MAX_MEMBERS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 500;
}

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const focus = gate.isCron ? await releaseEndedFocus().catch(() => ({ users: 0, released: 0 })) : { users: 0, released: 0 };
  const briefings = await runBriefingSweep({ workspaceId: gate.isCron ? null : gate.workspaceId, maxMembers: maxMembers() });
  return Response.json({ ok: true, focus, briefings });
}

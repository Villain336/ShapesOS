// ShapesOS — Phase 18.3 (WS=trust): the notifications sweep.
// POST /api/cron/notifications
//
// 1. Meetings starting: every member's events starting in the next 10
//    minutes (their connected calendars; bookings and operations events for
//    editors+) → one `meeting_starting` notification per occurrence
//    (lib/notifications/meetings.server.ts, through the producers).
// 2. Email digest: people with the daily digest on, once their morning has
//    come — one email of everything unread (lib/notifications/digest.server.ts,
//    the Alerts hub's email delivery). Cron only.
// 3. Agent-written summary: opted-in members' "what happened", written once
//    a day on the background workload (lib/notifications/summary.server.ts).
//    Cron only.
//
// Auth: the shared cron gate (lib/cron/gate.ts) — CRON_SECRET sweeps every
// workspace; a signed-in editor+ runs the meeting sweep for their own workspace.
// Schedule: every 5 minutes (lib/cron/jobs.ts "notifications").

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { allWorkspaceIds } from "@/lib/ops/helpdesk";
import { sweepMeetingsStarting } from "@/lib/notifications/meetings.server";
import { runEmailDigestSweep } from "@/lib/notifications/digest.server";
import { runSummarySweep, summaryTextFor } from "@/lib/notifications/summary.server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron ? await allWorkspaceIds() : [gate.workspaceId!];
  const meetings = await sweepMeetingsStarting({ workspaceIds });
  // The summary first, so a digest sent in the same run can carry it.
  const summaries = gate.isCron ? await runSummarySweep().catch(() => null) : null;
  const digests = gate.isCron ? await runEmailDigestSweep({ deps: { summaryFor: summaryTextFor } }).catch(() => null) : null;
  return Response.json({ ok: true, meetings, summaries, digests });
}

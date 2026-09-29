// Marketr — Phase 16 slice 8: daily recording retention sweep.
// POST /api/cron/recording-retention
//
// Locked decision (c): 30 days, then summarize — traces kept, videos dropped
// after 30 days unless pinned.
//
// Auth (either), same pattern as the other /api/cron/* routes:
//   1. Signed-in session (editor+) — sweeps the user's workspace only.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps every workspace.
//      Schedule daily (see DEPLOY.md): 0 3 * * *
//
// Idempotency: purged videos are marked (videoPath=null, videoPurgedAt set),
// so a re-run finds nothing to do. Traces are never deleted by this route.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { sweepExpiredRecordings } from "@/lib/agents/runs/retention";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const report = await sweepExpiredRecordings({
    ...(isCron ? {} : { workspaceId: sessionWorkspaceId! }),
  });

  return Response.json({ via: isCron ? "cron" : "session", ...report });
}

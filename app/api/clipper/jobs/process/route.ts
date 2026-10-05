// Marketr — Phase 13C: job processor entrypoint.
// POST /api/clipper/jobs/process — claims ONE pending ClipJob atomically and
// executes it inline. Intended to be called by the container/VPS lane (cron
// or a worker loop) — NOT the edge: execution uses child_process (ffmpeg),
// raw storage, and os.tmpdir() intermediates, so nodejs runtime only.
//
// Atomic claim: a single UPDATE ... WHERE id = (SELECT ... FOR UPDATE
// SKIP LOCKED) runs inside one short transaction with the workspace GUC set.
// Concurrent processors race on the lock; exactly one row is returned, and
// the losers get nothing (SKIP LOCKED). The claim transaction commits
// BEFORE execution starts, so the long ffmpeg/transcribe work never holds
// a DB transaction open.

import { guardWorkspace, httpErrorResponse } from "../../../integrations/_lib";
import { claimNextPendingJob, executeClaimedJob } from "../../../clipper/_pipeline";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const rl = await checkRateLimitAsync(`clipper-process:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const job = await claimNextPendingJob(workspace.id);
    if (!job) return Response.json({ claimed: false, job: null });

    try {
      await executeClaimedJob(job);
      return Response.json({ claimed: true, job: { id: job.id, kind: job.kind, status: "done" } });
    } catch (e) {
      return Response.json(
        {
          claimed: true,
          job: { id: job.id, kind: job.kind, status: "failed" },
          error: e instanceof Error ? e.message : "Job failed",
        },
        { status: 200 },
      );
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}

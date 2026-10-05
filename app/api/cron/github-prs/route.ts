// ShapesOS — Phase 9 (repos): poll open agent pull requests for feedback.
// POST /api/cron/github-prs — the webhook fallback for installs without a
// GitHub webhook (PAT mode): reads each open agent PR's reviews, comments
// and checks and continues the work from new feedback (lib/ship/poll.ts).
// Opt-in: does nothing unless GITHUB_PR_POLL=on.
// Auth: shared cron gate (lib/cron/gate.ts): CRON_SECRET service call (every
// workspace), or a signed-in editor+ session (their workspace only).

import { cronGate } from "@/lib/cron/gate";
import { pollAgentPullRequests, prPollEnabled } from "@/lib/ship/poll";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  if (!prPollEnabled()) return Response.json({ ok: true, skipped: "GITHUB_PR_POLL is off" });
  const result = await pollAgentPullRequests({ workspaceId: gate.workspaceId });
  return Response.json({ ok: true, ...result });
}

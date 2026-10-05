// ShapesOS — social status + engagement sweep (Phase 4b).
// POST /api/cron/social-engagement
//
// Auth (shared cron gate, lib/cron/gate.ts):
//   1. Authorization: Bearer <CRON_SECRET> — every workspace. Schedule
//      every 15 minutes (see DEPLOY.md).
//   2. Signed-in editor+ — the caller's workspace only.
// Work: scheduled posts the provider now reports published → published (+
// social_post.published webhook) or failed; then daily engagement for posts
// published in the last 30 days (hourly per post) → social_post_metrics.

import { cronGate } from "@/lib/cron/gate";
import { runSocialSync, syncSocialWorkspace } from "@/lib/social/engagement";
import { getSocialProvider } from "@/lib/social/provider";
import { withWorkspaceSidecars } from "@/lib/integrations/sidecar-tenancy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  if (!gate.isCron) {
    // Phase 15.1: the signed-in workspace's own sidecar scope.
    return withWorkspaceSidecars(gate.workspaceId!, async () => {
      // Phase 15.4: the provider is per workspace (its Zernio profile on hosted).
      const provider = getSocialProvider(gate.workspaceId);
      if (!provider) return Response.json({ skipped: "no social provider configured" });
      return Response.json(await syncSocialWorkspace(gate.workspaceId!, provider));
    });
  }
  return Response.json(await runSocialSync());
}

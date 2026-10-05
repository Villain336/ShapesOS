// ShapesOS — sync social status + engagement now (Phase 4b).
// POST /api/social/sync → { refresh, ingest } (editor+)
// Same work as the /api/cron/social-engagement sweep, for this workspace
// only, ignoring the hourly re-poll interval.

import { syncSocialWorkspace } from "@/lib/social/engagement";
import { getSocialProvider, SOCIAL_NOT_CONNECTED_MESSAGE } from "@/lib/social/provider";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { BadRequestError } from "@/lib/api/errors";
import { guardWorkspace, socialError } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const rl = await checkRateLimitAsync(`social-sync:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
    const provider = getSocialProvider(workspace.id);
    if (!provider) throw new BadRequestError(SOCIAL_NOT_CONNECTED_MESSAGE);
    return Response.json(await syncSocialWorkspace(workspace.id, provider, new Date(), { force: true }));
  } catch (e) {
    return socialError(e);
  }
}

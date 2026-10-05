// Marketr — Listmonk sidecar: send a campaign (Phase 12).
// POST /api/integrations/listmonk/campaigns/[id]/send { mode: "now" | "scheduled", runAt? }
//   → { campaign }
// IRREVERSIBLE real-world email send. The UI requires an explicit typed
// confirmation before calling this; the route rate-limits sends per
// workspace on top of the global write tier. Never auto-called.

import { z } from "zod";
import { guardWorkspace, readJson, sidecarError } from "../../../../_lib";
import {
  scheduleListmonkCampaign,
  sendListmonkCampaign,
} from "@/lib/integrations/listmonk";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  mode: z.enum(["now", "scheduled"]),
  runAt: z.string().trim().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    // Send protection: expensive + irreversible sends get a per-workspace
    // write-tier limit, on top of the proxy's write tier.
    const rl = await checkRateLimitAsync(`listmonk-send:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);

    const { id } = await ctx.params;
    const campaignId = Number(id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return Response.json({ error: "Invalid campaign id." }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    if (parsed.data.mode === "scheduled" && !parsed.data.runAt) {
      return Response.json({ error: "runAt is required when mode is scheduled." }, { status: 400 });
    }
    const campaign =
      parsed.data.mode === "now"
        ? await sendListmonkCampaign(campaignId)
        : await scheduleListmonkCampaign(campaignId, parsed.data.runAt as string);
    return Response.json({ campaign });
  } catch (e) {
    return sidecarError(e);
  }
}

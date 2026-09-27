// Marketr — Postiz sidecar: connection status (Phase 12).
// GET /api/integrations/postiz/status → { configured, isLive, channels }.
// `channels` is a best-effort live count; 0 when unconfigured or unreachable.

import { guardWorkspace, sidecarError } from "../../_lib";
import { listPostizChannels, postizStatus } from "@/lib/integrations/postiz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await guardWorkspace();
    const s = postizStatus();
    let channelCount: number | null = null;
    if (s.configured) {
      try {
        channelCount = (await listPostizChannels()).length;
      } catch {
        channelCount = null;
      }
    }
    return Response.json({
      ...s,
      channels: channelCount,
      envVars: ["POSTIZ_URL", "POSTIZ_API_KEY"],
    });
  } catch (e) {
    return sidecarError(e);
  }
}

// ShapesOS — social channels + provider mode (Phase 4b).
// GET /api/social/channels → { mode: "postiz" | "mock" | "none", channels, maxUploadBytes } (viewer+)
// mode "mock": no Postiz credentials (development / SOCIAL_MOCK_MODE=1) —
// the channels are sample channels and the UI says so.

import { getSocialProvider } from "@/lib/social/provider";
import { socialMaxUploadBytes } from "@/lib/social/platforms";
import { guardWorkspace, socialError } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const provider = getSocialProvider(workspace.id);
    const maxUploadBytes = socialMaxUploadBytes();
    if (!provider) return Response.json({ mode: "none", channels: [], maxUploadBytes });
    return Response.json({ mode: provider.name, channels: await provider.listChannels(), maxUploadBytes });
  } catch (e) {
    return socialError(e);
  }
}

// ShapesOS — social channels + provider mode (Phase 4b).
// GET /api/social/channels → { mode: "postiz" | "mock" | "none", channels, maxUploadBytes } (viewer+)
// mode "mock": no Postiz credentials (development / SOCIAL_MOCK_MODE=1) —
// the channels are sample channels and the UI says so.

import { getSocialProvider } from "@/lib/social/provider";
import { socialMaxUploadBytes } from "@/lib/social/platforms";
import { guardWorkspace, socialError } from "../_lib";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGET() {
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

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);

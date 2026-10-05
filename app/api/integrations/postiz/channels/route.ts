// Marketr — Postiz sidecar: connected channels (Phase 12).
// GET /api/integrations/postiz/channels → { channels }.
// Channels are connected inside the Postiz instance (its own OAuth UI);
// Marketr never sees or stores platform tokens — only integration ids.

import { guardWorkspace, sidecarError } from "../../_lib";
import { listPostizChannels } from "@/lib/integrations/postiz";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGET() {
  try {
    await guardWorkspace();
    return Response.json({ channels: await listPostizChannels() });
  } catch (e) {
    return sidecarError(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);

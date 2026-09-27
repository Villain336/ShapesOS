// Marketr — Postiz sidecar: connected channels (Phase 12).
// GET /api/integrations/postiz/channels → { channels }.
// Channels are connected inside the Postiz instance (its own OAuth UI);
// Marketr never sees or stores platform tokens — only integration ids.

import { guardWorkspace, sidecarError } from "../../_lib";
import { listPostizChannels } from "@/lib/integrations/postiz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await guardWorkspace();
    return Response.json({ channels: await listPostizChannels() });
  } catch (e) {
    return sidecarError(e);
  }
}

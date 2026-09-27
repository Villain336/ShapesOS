// Marketr — Listmonk sidecar: connection status (Phase 12).
// GET /api/integrations/listmonk/status → { configured, isLive }

import { guardWorkspace, sidecarError } from "../../_lib";
import { listmonkStatus } from "@/lib/integrations/listmonk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await guardWorkspace();
    const s = listmonkStatus();
    // Names the env vars when unconfigured; never the values.
    return Response.json({
      ...s,
      envVars: ["LISTMONK_URL", "LISTMONK_USER", "LISTMONK_TOKEN"],
    });
  } catch (e) {
    return sidecarError(e);
  }
}

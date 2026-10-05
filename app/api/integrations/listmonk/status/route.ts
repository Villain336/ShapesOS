// Marketr — Listmonk sidecar: connection status (Phase 12).
// GET /api/integrations/listmonk/status → { configured, isLive }

import { guardWorkspace, sidecarError } from "../../_lib";
import { listmonkStatus } from "@/lib/integrations/listmonk";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGET() {
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

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);

// Marketr — GET /api/integrations/activepieces/status (Phase 12, Worker 3).
// Engine reachability for Settings → Providers and the missions modal.
// Never returns key material.

import { activepiecesStatus, probeActivepiecesEngine } from "@/lib/integrations/activepieces";
import { integrationsGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  const status = activepiecesStatus();
  const probe = status.configured ? await probeActivepiecesEngine() : { ok: false as const, reason: "not-configured" };
  return Response.json({ ...status, probe });
}

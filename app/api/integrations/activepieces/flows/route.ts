// Marketr — GET /api/integrations/activepieces/flows (Phase 12, Worker 3).
// List flows on the Activepieces engine. Honest 503 when not connected.

import { listFlows } from "@/lib/integrations/activepieces";
import { integrationsGuard, engineError } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 100));
  const cursor = url.searchParams.get("cursor");
  try {
    const page = await listFlows({ limit, ...(cursor ? { cursor } : {}) });
    if (!page.configured) {
      return Response.json(
        {
          configured: false,
          flows: [],
          error:
            "Activepieces is not connected. Set ACTIVEPIECES_URL and ACTIVEPIECES_API_KEY " +
            "on the host (Settings → Providers) to list flows.",
        },
        { status: 503 },
      );
    }
    return Response.json({ configured: true, flows: page.flows, nextCursor: page.nextCursor });
  } catch (e) {
    return engineError(e);
  }
}

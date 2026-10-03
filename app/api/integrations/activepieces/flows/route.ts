// Marketr — GET /api/integrations/activepieces/flows (Phase 12, Worker 3).
// List the flows bound to the caller's workspace (Phase 1, H6 — the engine is
// host-wide). Platform operators may pass ?scope=engine to see every engine
// flow with its binding, so they can bind new ones. Honest 503 when not connected.

import { listFlows, prismaFlowBindingStore, workspaceFlows } from "@/lib/integrations/activepieces";
import { isPlatformOperator } from "@/lib/auth/platform-operator";
import { requireUser } from "@/lib/session";
import { integrationsGuard, engineError } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await integrationsGuard("viewer");
  if (gate instanceof Response) return gate;
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 50, 100));
  const cursor = url.searchParams.get("cursor");
  const engineScope = url.searchParams.get("scope") === "engine";
  if (engineScope && !isPlatformOperator(await requireUser())) {
    return Response.json({ error: "Platform operators only." }, { status: 403 });
  }
  try {
    const opts = { limit, ...(cursor ? { cursor } : {}) };
    const page = engineScope ? await listFlows(opts) : await workspaceFlows(gate.workspaceId).list(opts);
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
    if (engineScope) {
      const store = prismaFlowBindingStore();
      const flows = await Promise.all(
        page.flows.map(async (f) => ({ ...f, boundWorkspaceId: await store.ownerOf(f.id) })),
      );
      return Response.json({ configured: true, flows, nextCursor: page.nextCursor });
    }
    return Response.json({ configured: true, flows: page.flows, nextCursor: page.nextCursor });
  } catch (e) {
    return engineError(e);
  }
}

// Marketr — Phase 14: action connections API.
// GET  /api/integrations/actions/connections       — list workspace connections
// POST /api/integrations/actions/connections       — initiate OAuth connect
//        { appKey } → { connectUrl, expiresAt } (minted fresh; ~12 min TTL)

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import {
  initiateConnect,
  listConnections,
} from "@/lib/integrations/actions/connections";
import { V1_COMPOSIO_APPS } from "@/lib/integrations/actions/risk";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  appKey: z.string().trim().min(1).max(64),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const connections = await listConnections(workspace.id);
    return Response.json({ connections, apps: V1_COMPOSIO_APPS });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = BodySchema.parse(await readJson(req));
    // Composio user id: stable per Marketr user so reconnects rebind.
    const result = await initiateConnect({
      workspaceId: workspace.id,
      appKey: body.appKey,
      userId: user.id,
    });
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}

// Marketr — studio API: start the Canva OAuth connect flow (milestone 22).
// POST /api/studio/canva/connect { workspaceId } → { authorizeUrl } (editor+)

import { requireUser } from "@/lib/session";
import { createCanvaPort } from "@/lib/studio/canva";
import { createCanvaAuthorizeUrl } from "@/lib/studio/service";
import {
  canvaClientConfig,
  canvaRedirectUri,
  ownedWorkspace,
  readJson,
  requireWorkspaceEditor,
} from "../../_lib";

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const ws = await ownedWorkspace(user.id, body.workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;

  const client = canvaClientConfig();
  if (!client.clientId) {
    return Response.json(
      { error: "CANVA_CLIENT_ID is not configured — see DEPLOY.md §4c." },
      { status: 400 },
    );
  }
  try {
    const { url } = createCanvaAuthorizeUrl(createCanvaPort(), ws.id, user.id, {
      clientId: client.clientId,
      redirectUri: canvaRedirectUri(req),
    });
    return Response.json({ authorizeUrl: url });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to start the connect flow." },
      { status: 400 },
    );
  }
}

// ShapesOS — Phase 18.3 (WS=trust): agent app permissions.
//   GET /api/trust/agent-apps → { blocked: ToolGroup[], blockable: ToolGroup[], canEdit }
//     viewer+ (the Store and the agent picker show what is blocked)
//   PUT /api/trust/agent-apps { blocked: string[] } → { blocked }
//     admin+; audited (agent_app_access_changed). Enforced in computeGrant()
//     and at execute time (lib/agents/app-permissions.ts).

import { roleAtLeast } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { BLOCKABLE_GROUPS } from "@/lib/agents/grants";
import { getAgentBlockedGroups, setAgentBlockedGroups } from "@/lib/agents/app-permissions";
import { NO_STORE, trustGuard } from "../_lib";

export const dynamic = "force-dynamic";

const PutSchema = z.object({ blocked: z.array(z.string().max(40)).max(40) });

export async function GET() {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const blocked = await getAgentBlockedGroups(ctx.workspaceId, { fresh: true });
    return Response.json({ blocked, blockable: BLOCKABLE_GROUPS, canEdit: roleAtLeast(ctx.role, "admin") }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/trust/agent-apps");
  }
}

export async function PUT(req: Request) {
  const ctx = await trustGuard("admin");
  if (ctx instanceof Response) return ctx;
  try {
    const parsed = validateBody(PutSchema, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const blocked = await setAgentBlockedGroups(ctx.workspaceId, parsed.data.blocked, ctx.userId);
    return Response.json({ blocked }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "PUT /api/trust/agent-apps");
  }
}

// ShapesOS — Phase 18.2 (WS=content): install or remove one Store item.
// POST /api/store/items { action: "install"|"remove", kind, key, confirmed: true }
//   → { kind, key, installed }
// requireWorkspaceRole editor here; each kind then applies its OWN existing
// permission (lib/store/service.ts): skills = admin or the skills.install
// grant, mini-apps and mission templates = admin, Composio toolkits =
// editor. Installing needs `confirmed: true` — the page shows the item's
// tools, tiers and permissions first. Connectors / MCP servers are refused
// with where to connect them (Settings → Connectors). Audited.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { BadRequestError, errorResponse } from "@/lib/api/errors";
import { installStoreItem, removeStoreItem } from "@/lib/store/service";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["install", "remove"]),
  kind: z.string().max(32),
  key: z.string().min(1).max(120),
  confirmed: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    const m = await requireWorkspaceRole(user.id, workspace.id, "editor");
    if (!m) return forbidden();
    const body = Body.parse(await req.json().catch(() => null));
    const actor = { workspaceId: workspace.id, userId: user.id, role: m.role };
    if (body.action === "install") {
      if (body.confirmed !== true) throw new BadRequestError("Confirm the permissions first (confirmed: true).");
      return Response.json(await installStoreItem(actor, body.kind, body.key));
    }
    return Response.json(await removeStoreItem(actor, body.kind, body.key));
  } catch (err) {
    return errorResponse(err, "POST /api/store/items");
  }
}

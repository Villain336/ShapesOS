// ShapesOS — Phase 21A round 2 (WS=agentweb): the logic behind the browsing-memory routes.
// Everything is the signed-in member's OWN memory (their user id is the key; there is no way to
// name another member's). Any member may use it: it is their own reading history.

import { humanClickGuard } from "../commerce/http";
import { forgetAll, forgetItem, forgetSite, getMemorySettings, listMemory, saveMemorySettings } from "./store";
import { normalizeSite } from "./policy";

export interface Actor {
  userId: string;
  workspaceId: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function memoryOverview(actor: Actor, q?: string) {
  const [settings, items] = await Promise.all([getMemorySettings(actor.workspaceId, actor.userId), listMemory(actor.workspaceId, actor.userId, { q, limit: 200 })]);
  return { settings, items };
}

export async function handleMemoryOp(actor: Actor, req: Request): Promise<Response> {
  const guard = await humanClickGuard(req, { requireChannel: false, subject: "Browsing memory", maxChars: 20_000 });
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  const body = guard.body;
  const op = typeof body.op === "string" ? body.op : "";
  if (op === "settings") {
    const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? (body.patch as Record<string, unknown>) : {};
    const out = await saveMemorySettings(actor.workspaceId, actor.userId, {
      ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
      ...(typeof patch.retentionDays === "number" ? { retentionDays: patch.retentionDays } : {}),
      ...(Array.isArray(patch.excludedSites) ? { excludedSites: patch.excludedSites as string[] } : {}),
    });
    return json(out);
  }
  if (op === "forget") {
    const id = typeof body.id === "string" ? body.id : "";
    return (await forgetItem(actor.workspaceId, actor.userId, id)) ? json({ ok: true }) : json({ error: "That item was not found." }, 404);
  }
  if (op === "forget_site") {
    const site = normalizeSite(body.site);
    if (!site) return json({ error: "Give a site, like example.com." }, 400);
    return json({ forgotten: await forgetSite(actor.workspaceId, actor.userId, site) });
  }
  if (op === "forget_all") return json({ forgotten: await forgetAll(actor.workspaceId, actor.userId) });
  return json({ error: "Unknown operation." }, 400);
}

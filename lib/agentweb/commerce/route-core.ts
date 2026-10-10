// ShapesOS — Phase 21A round 2 (WS=agentweb): the logic behind the mandate routes, with the
// actor passed in (so it is testable without a session). The route files only resolve the
// signed-in person and call these.

import { roleAtLeast } from "@/lib/authz";
import { humanClickGuard } from "./http";
import { MandateRefused } from "./mandate";
import { MandateStoreError, rejectMandateById, signMandateById } from "./mandate-store";
import { finishAfterSignature } from "./finish";

export interface Actor {
  userId: string;
  workspaceId: string;
  role: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function handleSign(actor: Actor, req: Request, id: string): Promise<Response> {
  const guard = await humanClickGuard(req, { requireChannel: true });
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  if (!roleAtLeast(actor.role as never, "editor")) return json({ error: "Only an editor or above can approve a cart." }, 403);
  try {
    const mandate = await signMandateById(actor.workspaceId, id, { userId: actor.userId, role: actor.role, channel: "ui_click" });
    const outcome = await finishAfterSignature(actor.workspaceId, id, actor.userId);
    return json({ mandate, outcome });
  } catch (e) {
    if (e instanceof MandateRefused) return json({ error: e.message, code: e.code }, 403);
    if (e instanceof MandateStoreError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 409);
    throw e;
  }
}

export async function handleReject(actor: Actor, req: Request, id: string): Promise<Response> {
  const guard = await humanClickGuard(req, { requireChannel: false });
  if (!guard.ok) return json({ error: guard.error }, guard.status);
  if (!roleAtLeast(actor.role as never, "editor")) return json({ error: "Only an editor or above can decide a cart." }, 403);
  try {
    return json({ mandate: await rejectMandateById(actor.workspaceId, id, actor.userId) });
  } catch (e) {
    if (e instanceof MandateStoreError) return json({ error: e.message, code: e.code }, e.code === "not_found" ? 404 : 409);
    throw e;
  }
}

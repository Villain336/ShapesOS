// ShapesOS — Phase 10 (portal): POST /api/portal/logout — revoke this portal
// session (portalGuard: portal cookie + CSRF) and clear the cookie. Without a
// live session it still clears the cookie.

import { portalError, portalGuard, withPortalCookie } from "@/lib/portal/http";
import { revokePortalSessions } from "@/lib/portal/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const p = await portalGuard(req);
    if (p instanceof Response) {
      if (p.status !== 401) return p;
    } else {
      await revokePortalSessions(p.workspaceId, p.clientId, "client", { sessionId: p.sessionId });
    }
    return withPortalCookie(Response.json({ ok: true }), req, null);
  } catch (err) {
    return portalError(err);
  }
}

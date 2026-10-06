// ShapesOS — Phase 18.3 (WS=trust): sign every other session out.
//   POST /api/trust/sessions/others → { revoked: number }
// Keeps the caller's current session; every other row of the caller's is
// revoked, and tokens from before the registry are cut off too. Audited.

import { auditEvent } from "@/lib/auditlog";
import { errorResponse } from "@/lib/api/errors";
import { revokeOtherSessions } from "@/lib/auth/sessions";
import { NO_STORE, currentSessionId, trustGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST() {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const current = await currentSessionId(ctx.userId);
    const revoked = await revokeOtherSessions(ctx.userId, current, "self");
    await auditEvent({
      projectId: null,
      workspaceId: ctx.workspaceId,
      action: "session_revoked",
      actorUserId: ctx.userId,
      summary: `Signed out every other session (${revoked} listed${current ? "" : "; this browser predates the session list"})`,
    });
    return Response.json({ revoked }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "POST /api/trust/sessions/others");
  }
}

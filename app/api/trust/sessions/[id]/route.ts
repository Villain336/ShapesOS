// ShapesOS — Phase 18.3 (WS=trust): sign one of your sessions out.
//   DELETE /api/trust/sessions/[id] → { revoked: boolean }
// Only the caller's own rows can match (owner-only RLS + userId = subject).
// That browser is signed out on its next request (auth.ts jwt callback).
// Audited (session_revoked) in the active workspace.

import { auditEvent } from "@/lib/auditlog";
import { errorResponse } from "@/lib/api/errors";
import { revokeUserSession } from "@/lib/auth/sessions";
import { NO_STORE, currentSessionId, trustGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const { id } = await params;
    const current = await currentSessionId(ctx.userId);
    const revoked = await revokeUserSession(ctx.userId, String(id).slice(0, 64), "self");
    if (revoked) {
      await auditEvent({
        projectId: null,
        workspaceId: ctx.workspaceId,
        action: "session_revoked",
        actorUserId: ctx.userId,
        summary: id === current ? "Signed this session out" : "Signed one other session out",
      });
    }
    return Response.json({ revoked }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "DELETE /api/trust/sessions/[id]");
  }
}

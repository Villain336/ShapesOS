// ShapesOS — Phase 18.3 (WS=trust): remove one of your phones from push.
//   DELETE /api/trust/devices/[id] → { removed: boolean }
// The web counterpart of the mobile app's sign-out DELETE: the caller's own
// PushDevice rows in the active workspace only (FORCE RLS + userId = subject).
// Audited (push_device_removed).

import { auditEvent } from "@/lib/auditlog";
import { errorResponse } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { NO_STORE, trustGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const { id } = await params;
    const res = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.pushDevice.deleteMany({ where: { id: String(id).slice(0, 64), workspaceId: ctx.workspaceId, userId: ctx.userId } }),
    );
    if (res.count > 0) {
      await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, action: "push_device_removed", actorUserId: ctx.userId, summary: "Removed a phone from push notifications" });
    }
    return Response.json({ removed: res.count > 0 }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "DELETE /api/trust/devices/[id]");
  }
}

// ShapesOS — the signed-in user's own account (Phase 4a, GDPR erasure).
//   GET    /api/account                → what deleting the account would do
//                                         (workspaces deleted / left / blocking)
//   DELETE /api/account { confirm }    → delete it (lib/gdpr/account-delete.ts):
//          the account email typed back (or "delete my account" without one);
//          refused while the user is the only owner of a workspace with other
//          members. Clears the session cookies; the client then signs out.
// Self-service: no id is read from the request; everything is keyed to the
// session's own subject (requireSelfService).

import { NextResponse } from "next/server";
import { requireSelfService } from "@/lib/auth/require-self-service";
import { errorResponse } from "@/lib/api/errors";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/session";
import { log, requestIdFrom } from "@/lib/observability/log";
import { accountConfirmationText, blockerMessage, deleteAccount, previewAccountDeletion } from "@/lib/gdpr/account-delete";

export const dynamic = "force-dynamic";

/** Auth.js v5 session cookie names (plain and __Secure- on https). */
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export async function GET(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const plan = await previewAccountDeletion(me.id);
    return Response.json({
      confirmText: accountConfirmationText(me.email),
      deleteWorkspaces: plan.deleteWorkspaces,
      leaveWorkspaces: plan.leaveWorkspaces.map((w) => ({ id: w.id, name: w.name })),
      blockers: plan.blockers,
      blockedMessage: blockerMessage(plan),
    });
  } catch (err) {
    return errorResponse(err, "GET /api/account", req);
  }
}

export async function DELETE(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
    const result = await deleteAccount({ userId: me.id, email: me.email, confirm: body?.confirm });
    log.info("account deleted", {
      requestId: requestIdFrom(req),
      deletedWorkspaces: result.deletedWorkspaces.length,
      leftWorkspaces: result.leftWorkspaces.length,
      personalRowsDeleted: result.personalRowsDeleted,
      referencesPseudonymized: result.referencesPseudonymized,
    });
    const res = NextResponse.json({ ok: true, ...result });
    const expire = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 0 };
    res.cookies.set(ACTIVE_WORKSPACE_COOKIE, "", expire);
    for (const name of SESSION_COOKIES) {
      res.cookies.set(name, "", { ...expire, secure: name.startsWith("__Secure-") });
    }
    return res;
  } catch (err) {
    return errorResponse(err, "DELETE /api/account", req);
  }
}

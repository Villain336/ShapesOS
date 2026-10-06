// ShapesOS — Phase 18.3 (WS=trust): your sessions (Settings → You → Privacy).
//   GET /api/trust/sessions → { sessions: SessionView[], current: boolean (this browser is listed) }
// The caller's own sessions only (user_sessions is owner-only RLS on the
// session subject); no id is read from the request.

import { errorResponse } from "@/lib/api/errors";
import { listUserSessions } from "@/lib/auth/sessions";
import { NO_STORE, currentSessionId, trustGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await trustGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const sid = await currentSessionId(ctx.userId);
    const sessions = await listUserSessions(ctx.userId, sid);
    return Response.json({ sessions, current: !!sid && sessions.some((s) => s.current) }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/trust/sessions");
  }
}

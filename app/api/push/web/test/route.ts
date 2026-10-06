// ShapesOS — Phase 18.3 (WS=flow): send a test push to my own browsers.
//   POST /api/push/web/test → { sent, failed, removed, skipped }
// Self-service: only the session subject's own subscriptions are contacted.

import { requireSelfService } from "@/lib/auth/require-self-service";
import { errorResponse } from "@/lib/api/errors";
import { sendWebPush } from "@/lib/push/web";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const result = await sendWebPush(me.id, { title: "ShapesOS", body: "Web Push works on this browser.", href: "/dashboard/notifications", tag: "test" });
    if (result.skipped === "not_configured") return Response.json({ ...result, error: `Web Push is off: ${result.reason}` }, { status: 409 });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err, "POST /api/push/web/test", req);
  }
}

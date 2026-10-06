// ShapesOS — Phase 18.3 (WS=flow): this person's Web Push subscriptions.
//   GET    /api/push/web                         → { configured, publicKey, reason?, subscriptions }
//   POST   /api/push/web { subscription }        → { id }   (this browser's PushSubscription.toJSON())
//   DELETE /api/push/web { endpoint } | ?id=     → { removed }
// Self-service (requireSelfService): no user id is read from the request;
// every row is the session subject's own (push_subscriptions is owner-only
// FORCE RLS on app.user_id). Without VAPID keys Web Push is off: GET says why,
// POST answers 409 and stores nothing.

import { requireSelfService } from "@/lib/auth/require-self-service";
import { currentSessionId } from "@/lib/auth/current-session";
import { errorResponse } from "@/lib/api/errors";
import { vapidConfigFromEnv } from "@/lib/push/vapid";
import { listWebPushSubscriptions, parseSubscription, removeWebPushSubscription, saveWebPushSubscription } from "@/lib/push/web";

export const dynamic = "force-dynamic";

const MAX_BODY = 8_192;

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v = JSON.parse(text || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const vapid = vapidConfigFromEnv();
    const subscriptions = vapid.configured ? await listWebPushSubscriptions(me.id) : [];
    return Response.json(
      vapid.configured
        ? { configured: true, publicKey: vapid.config.publicKey, subscriptions }
        : { configured: false, publicKey: null, reason: vapid.reason, subscriptions },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "GET /api/push/web", req);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const vapid = vapidConfigFromEnv();
    if (!vapid.configured) return Response.json({ error: `Web Push is off: ${vapid.reason}` }, { status: 409 });
    const body = await readBody(req);
    if (!body) return Response.json({ error: "Invalid JSON" }, { status: 400 });
    const parsed = parseSubscription(body.subscription);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    const ua = req.headers.get("user-agent");
    // Phase 18.3 integration: remember which sign-in subscribed, so revoking
    // that session (Settings → You → Privacy) stops pushes to this browser.
    const sessionId = await currentSessionId(me.id).catch(() => null);
    const saved = await saveWebPushSubscription(me.id, { ...parsed.value, userAgent: ua, sessionId });
    return Response.json(saved, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/push/web", req);
  }
}

export async function DELETE(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const id = new URL(req.url).searchParams.get("id")?.trim() || undefined;
    const body = id ? {} : await readBody(req);
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : undefined;
    if (!id && !endpoint) return Response.json({ error: "Give the subscription's endpoint or id." }, { status: 400 });
    const removed = await removeWebPushSubscription(me.id, { id, endpoint });
    return Response.json({ removed });
  } catch (err) {
    return errorResponse(err, "DELETE /api/push/web", req);
  }
}

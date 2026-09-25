// Marketr — POST /api/webhooks/mail/postgrid (PUBLIC, no session).
//
// PostGrid delivery events, authenticated as a JWT (HS256) signed with the
// workspace's webhook secret. The token is read from
// `Authorization: Bearer <jwt>` or the body field `token`/`jwt` (exact
// PostGrid delivery field UNVERIFIED — both accepted; confirm against a
// live firing before trusting production traffic).
// Always 200 to PostGrid on internal failures; invalid signatures → 401.
// Idempotent via MailWebhookEvent.

import { ingestMailWebhook } from "@/lib/mail/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("authorization"); // "Bearer <jwt>"

  let tokenFromBody: string | null = null;
  try {
    const body = JSON.parse(rawBody) as { token?: unknown; jwt?: unknown };
    if (typeof body.token === "string") tokenFromBody = body.token;
    else if (typeof body.jwt === "string") tokenFromBody = body.jwt;
  } catch {
    // Non-JSON body: no token field; header Bearer is the only path.
  }

  try {
    const result = await ingestMailWebhook({
      providerName: "postgrid",
      rawBody,
      signature,
      tokenFromBody,
    });
    if (!result.accepted) {
      return Response.json({ error: result.reason ?? "rejected" }, { status: 401 });
    }
    return Response.json({ ok: true, eventsApplied: result.eventsApplied ?? 0 });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[mail:webhook:postgrid] ingest failed: ${e instanceof Error ? e.message : "unknown"}`);
    return Response.json({ ok: false }, { status: 200 });
  }
}

// ShapesOS — POST /api/messaging/inbound/email (Phase 4b)
//
// Inbound email reply webhook (no session auth — provider-signed).
// Capability model:
//   - Auth: Resend's Svix signature over the RAW body with this endpoint's
//     secret (RESEND_INBOUND_WEBHOOK_SECRET). Missing/invalid → 401; no secret
//     configured → 503 (fail closed, never accepted unsigned).
//   - Tenant: ONLY the signed reply address the mail was sent to
//     (reply+<workspaceId>-<hmac>@MESSAGING_INBOUND_EMAIL_DOMAIN, see
//     lib/messaging/inbound-email.ts). Nothing in the payload picks the
//     workspace; an address without a valid HMAC is ignored.
//   - Effect: appends one inbound row to that workspace's messaging ledger
//     (idempotent per Resend email id) so the reply threads in the CRM inbox.
//     It returns no tenant data.
// The body is fetched from Resend's receiving API (webhooks carry metadata
// only); a fetch failure answers 502 so Resend retries the delivery.

import { inboundEmailDomain, handleInboundEmail, InboundEmailFetchError, verifyInboundEmailSignature, type ReceivedEmailEvent } from "@/lib/messaging/inbound-email";
import { log } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!inboundEmailDomain()) {
    return Response.json({ error: "Inbound email is not configured." }, { status: 503 });
  }
  if (!(process.env.RESEND_INBOUND_WEBHOOK_SECRET ?? "").trim()) {
    return Response.json({ error: "Webhook secret is not configured." }, { status: 503 });
  }
  const raw = await req.text();
  if (raw.length > 256_000) return Response.json({ error: "Payload too large." }, { status: 413 });
  if (!verifyInboundEmailSignature(raw, req.headers)) {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  let event: ReceivedEmailEvent;
  try {
    event = JSON.parse(raw) as ReceivedEmailEvent;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  try {
    const result = await handleInboundEmail(event);
    if (result.action === "ignored") return Response.json({ ok: true, action: "ignored" });
    return Response.json({ ok: true, action: result.action });
  } catch (err) {
    if (err instanceof InboundEmailFetchError) {
      log.warn("inbound email body fetch failed", { error: err.message });
      return Response.json({ error: "Couldn't fetch the email body; retry later." }, { status: 502 });
    }
    log.error("inbound email handling failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

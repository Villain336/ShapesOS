// Marketr — POST /api/messaging/inbound/sms
//
// Inbound SMS webhook (no session auth — provider-signed).
// Auth mirrors lib/calls/webhooks.ts:
//   - Twilio: X-Twilio-Signature (HMAC-SHA1 of url + sorted params).
//   - Fake:   X-Fake-Signature (HMAC-SHA256 of url + JSON(params)), or
//             Authorization: Bearer <FAKE_MESSAGING_SECRET>.
// Workspace resolution: ONLY the To number → callNumber (same as inbound
// voice). A request parameter is never trusted to pick the tenant.
//
// STOP/HELP/START keywords update ContactConsent; HELP gets a compliance
// reply sent directly (a mandated response to an inbound message, not a
// marketing send).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSmsProvider } from "@/lib/messaging/provider";
import { readWebhookParams } from "@/lib/calls/webhooks";
import { handleInboundSms, HELP_REPLY } from "@/lib/messaging/consent";

export const dynamic = "force-dynamic";

const TWIML_EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

export async function POST(req: NextRequest) {
  let provider;
  try {
    provider = getSmsProvider();
  } catch {
    return Response.json({ error: "SMS provider not configured" }, { status: 503 });
  }

  const params = await readWebhookParams(req);
  const signature =
    req.headers.get("x-twilio-signature") ??
    req.headers.get("x-fake-signature") ??
    req.headers.get("authorization");
  if (!provider.validateWebhookSignature({ url: req.url, params, signature })) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const from = (params.From ?? params.from ?? "").trim();
  const to = (params.To ?? params.to ?? "").trim();
  const body = params.Body ?? params.body ?? "";
  if (!from || !to) {
    return Response.json({ error: "Missing From/To" }, { status: 400 });
  }

  // Workspace: the tracking number the SMS hit (never a request param).
  const number = await prisma.callNumber.findUnique({
    where: { e164: to },
    select: { workspaceId: true, status: true },
  });
  if (!number || number.status !== "active") {
    return Response.json({ error: "Unknown destination number" }, { status: 400 });
  }
  const workspaceId = number.workspaceId;

  const result = await handleInboundSms({
    workspaceId,
    from,
    to,
    body,
    messageSid: params.MessageSid ?? params.messageSid,
  });

  // HELP gets a direct compliance reply (not a queued marketing send).
  if (result.action === "help") {
    try {
      const sid = await provider.sendSms({ to: from, from: to, body: HELP_REPLY });
      await prisma.outboundMessage.create({
        data: {
          workspaceId,
          leadId: result.leadId,
          channel: "sms",
          direction: "outbound",
          kind: "manual",
          body: HELP_REPLY,
          status: sid.providerSid ? "sent" : "failed",
          sentAt: new Date(),
          provider: provider.name,
          providerSid: sid.providerSid ?? null,
          costCents: 1,
        },
      });
    } catch {
      // best-effort — the inbound handling above already succeeded
    }
  }

  if (provider.name === "twilio") {
    return new Response(TWIML_EMPTY, {
      headers: { "Content-Type": "text/xml" },
    });
  }
  return Response.json({ ok: true, action: result.action });
}

// Marketr — Calls webhook: inbound voice.
//
// POST /api/calls/webhooks/twilio/voice — PUBLIC BY DESIGN (Twilio calls it),
// authenticated by the provider's webhook signature, NOT by a session.
// Invalid signature → 403. Unknown or released number → 404, no rows.

import { validateWebhook } from "@/lib/calls/webhooks";
import { handleInboundVoice } from "@/lib/calls/inbound";

export async function POST(req: Request) {
  const v = await validateWebhook(req);
  if (!v.ok) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 403 });
  }
  const { From = "", To = "", CallSid = "" } = v.params;
  if (!From || !To || !CallSid) {
    return Response.json({ error: "Missing From/To/CallSid" }, { status: 400 });
  }

  const res = await handleInboundVoice({ to: To, from: From, callSid: CallSid });
  if (!res.ok) {
    return Response.json({ error: res.reason === "number_released" ? "Number released" : "Number not found" }, { status: 404 });
  }
  const twiml = v.provider.inboundResponse(CallSid);
  return new Response(twiml.body, {
    status: 200,
    headers: { "content-type": twiml.contentType },
  });
}

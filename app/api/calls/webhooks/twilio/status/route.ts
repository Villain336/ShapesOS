// Marketr — Calls webhook: call status callback.
//
// POST /api/calls/webhooks/twilio/status — PUBLIC BY DESIGN, signature-
// authenticated. Finalizes the Call row: duration, transcription, summary,
// lead match/create, call-source attribution touch. Idempotent on the
// provider call SID (retried deliveries return 200 without side effects).

import { validateWebhook } from "@/lib/calls/webhooks";
import { handleCallStatus } from "@/lib/calls/inbound";

export async function POST(req: Request) {
  const v = await validateWebhook(req);
  if (!v.ok) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 403 });
  }
  const { CallSid = "", CallStatus = "", CallDuration = "", RecordingUrl = "" } = v.params;
  if (!CallSid) {
    return Response.json({ error: "Missing CallSid" }, { status: 400 });
  }

  const res = await handleCallStatus({
    callSid: CallSid,
    providerStatus: CallStatus || "completed",
    durationSec: Number(CallDuration) || 0,
    recordingUrl: RecordingUrl || null,
  });
  if (!res.ok) {
    return Response.json({ error: "Unknown call" }, { status: 404 });
  }
  return Response.json({ ok: true, callId: res.callId, duplicate: res.duplicate ?? false });
}

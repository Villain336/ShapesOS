// Marketr — Calls webhook: transcription callback.
//
// POST /api/calls/webhooks/twilio/transcription — PUBLIC BY DESIGN,
// signature-authenticated. Twilio posts here from the <Record>
// transcribeCallback when TwilioProvider.inboundResponse's
// transcribe="true" finishes (params: CallSid, TranscriptionText,
// TranscriptionSid, TranscriptionStatus).
//
// With the fake provider transcription is a fixture (see
// FakeTelephonyProvider.transcribe); this route is the live wiring point
// and is exercised in the battery with a fake-signed request.

import { prisma } from "@/lib/prisma";
import { validateWebhook } from "@/lib/calls/webhooks";

export async function POST(req: Request) {
  const v = await validateWebhook(req);
  if (!v.ok) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 403 });
  }
  const { CallSid = "", TranscriptionText = "", TranscriptionStatus = "" } = v.params;
  if (!CallSid) {
    return Response.json({ error: "Missing CallSid" }, { status: 400 });
  }
  const call = await prisma.call.findUnique({
    where: { externalSid: CallSid },
    select: { id: true, summary: true },
  });
  if (!call) {
    return Response.json({ error: "Unknown call" }, { status: 404 });
  }
  await prisma.call.update({
    where: { id: call.id },
    data: {
      transcription: TranscriptionText || null,
      // Fill the summary only if finalization hasn't written one yet; the
      // status callback's summary (duration/outcome) wins otherwise.
      summary: !call.summary && TranscriptionText ? TranscriptionText.slice(0, 280) : undefined,
    },
  });
  return Response.json({ ok: true, status: TranscriptionStatus || "received" });
}

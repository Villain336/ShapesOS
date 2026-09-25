// Marketr — POST /api/webhooks/mail/lob (PUBLIC, no session).
//
// Lob lifecycle events (in_transit → in_local_area → processed_for_delivery
// → delivered, plus returned_to_sender / failed). Authenticated by Lob's
// documented signature scheme:
//   HMAC-SHA256(webhookSecret, "<Lob-Signature-Timestamp>.<rawBody>") hex
//   vs the Lob-Signature header (10-minute timestamp tolerance).
// Always 200 to Lob (even on internal failures) to avoid retry storms;
// invalid signatures → 401. Idempotent via MailWebhookEvent.

import { ingestMailWebhook } from "@/lib/mail/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("lob-signature");
  const timestamp = req.headers.get("lob-signature-timestamp");

  try {
    const result = await ingestMailWebhook({
      providerName: "lob",
      rawBody,
      signature,
      timestamp,
    });
    if (!result.accepted) {
      return Response.json({ error: result.reason ?? "rejected" }, { status: 401 });
    }
    return Response.json({ ok: true, eventsApplied: result.eventsApplied ?? 0 });
  } catch (e) {
    // Always 200 to the provider; log internally and move on.
    // eslint-disable-next-line no-console
    console.error(`[mail:webhook:lob] ingest failed: ${e instanceof Error ? e.message : "unknown"}`);
    return Response.json({ ok: false }, { status: 200 });
  }
}

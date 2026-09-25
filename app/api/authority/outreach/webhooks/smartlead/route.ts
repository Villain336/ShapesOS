// Marketr — O1 POST /api/authority/webhooks/smartlead
// Signature-verified (HMAC-SHA256), idempotent, stop-on-reply enforced.
// Configure with SMARTLEAD_WEBHOOK_SECRET. Signature header: x-marketr-signature.

import { handleProviderEvent } from "@/app/api/authority/outreach/webhooks/_handler";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleProviderEvent(req, "smartlead");
}

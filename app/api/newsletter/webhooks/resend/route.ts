// Marketr — newsletter API: Resend webhook receiver (milestone 19).
// POST /api/newsletter/webhooks/resend
//
// Handles email.bounced / email.complained → subscriber status updates.
// Day-1 hardening (H2): FAIL CLOSED — unsigned payloads are rejected unless
// RESEND_WEBHOOK_SECRET is set (Svix verification) or the operator explicitly
// opts into the dev-only fallback with ALLOW_UNSIGNED_WEBHOOKS=true.

import { prisma } from "@/lib/prisma";
import { handleResendWebhook } from "@/lib/newsletter/service";
import { verifyWebhookRequest } from "@/lib/newsletter/webhook-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  let event: { type?: string; data?: { to?: string[]; email?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  // Day-1 hardening (H2): fail-closed webhook authentication — see
  // lib/newsletter/webhook-auth.ts.
  const denied = await verifyWebhookRequest(req, raw);
  if (denied) return denied;
  const result = await handleResendWebhook(prisma, event);
  return Response.json(result);
}

// Marketr — newsletter API: Resend webhook receiver (milestone 19).
// POST /api/newsletter/webhooks/resend
//
// Handles email.bounced / email.complained → subscriber status updates.
// Signature verification (Svix) runs when RESEND_WEBHOOK_SECRET is set; when
// it isn't, the payload is accepted and the gap is logged — configure the
// secret in production (see DEPLOY.md).

import { Resend } from "resend";
import { prisma } from "@/lib/prisma";
import { handleResendWebhook } from "@/lib/newsletter/service";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  const raw = await req.text();
  let event: { type?: string; data?: { to?: string[]; email?: string } };
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (secret) {
    try {
      const resend = new Resend("re_verify_only");
      // Resend's verify expects the Svix header triple (id/timestamp/signature).
      resend.webhooks.verify({
        payload: raw,
        headers: {
          id: req.headers.get("svix-id") ?? "",
          timestamp: req.headers.get("svix-timestamp") ?? "",
          signature: req.headers.get("svix-signature") ?? "",
        },
        webhookSecret: secret,
      });
    } catch {
      return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
    }
  } else {
    console.warn("[newsletter] RESEND_WEBHOOK_SECRET not set — accepting unsigned webhook (dev only).");
  }
  const result = await handleResendWebhook(prisma, event);
  return Response.json(result);
}

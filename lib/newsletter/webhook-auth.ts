// Marketr — Resend webhook authentication gate (day-1 hardening, H2).
//
// FAIL CLOSED: unsigned payloads are rejected unless RESEND_WEBHOOK_SECRET is
// set (Svix signature verification) or the operator explicitly opts into the
// dev-only fallback with ALLOW_UNSIGNED_WEBHOOKS=true. Forged
// bounce/complaint events could otherwise silently suppress real subscribers.
//
// Extracted from the route so the gate is unit-testable without a database.

import { Resend } from "resend";

/**
 * Verify a Resend webhook request. Returns null when the request is
 * authenticated (or explicitly allowed unsigned); otherwise returns the
 * 4xx Response the route should send.
 */
export async function verifyWebhookRequest(
  req: Request,
  raw: string,
): Promise<Response | null> {
  const secret = (process.env.RESEND_WEBHOOK_SECRET ?? "").trim();
  const allowUnsigned =
    (process.env.ALLOW_UNSIGNED_WEBHOOKS ?? "").trim().toLowerCase() === "true";
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
      return null;
    } catch {
      return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
    }
  }
  if (!allowUnsigned) {
    // Fail closed.
    console.error(
      "[newsletter] rejected unsigned Resend webhook: RESEND_WEBHOOK_SECRET is not set",
    );
    return Response.json(
      { error: "Webhook secret is not configured." },
      { status: 401 },
    );
  }
  console.warn(
    "[newsletter] RESEND_WEBHOOK_SECRET not set — accepting unsigned webhook (ALLOW_UNSIGNED_WEBHOOKS=true, dev only).",
  );
  return null;
}

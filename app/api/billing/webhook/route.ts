// Marketr — Stripe webhook receiver (hosted top-up purchases).
// POST /api/billing/webhook
//
// PUBLIC BY DESIGN (M11): Stripe's servers call this endpoint, so there is
// no user session to authorize. Authorization IS the Stripe webhook
// signature: it is verified with stripe.webhooks.constructEvent BEFORE any
// JSON parsing, business logic, or database write — see
// lib/metering/THREAT-MODEL-BILLING.md B1. The raw body is read with
// req.text(); this route never parses unverified JSON. A bad signature is
// rejected with 400 (no retry for forgeries); transient failures return
// 500 so Stripe redelivers (replays are idempotent — B2).

import type { NextRequest } from "next/server";
import { StripeBillingSink, BillingNotConfiguredError } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Raw bytes for signature verification — never req.json() first.
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  const sink = new StripeBillingSink();

  let result;
  try {
    result = await sink.handleWebhook(rawBody, signature);
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      // Misconfigured hosted deployment: tell Stripe to stop retrying a
      // path that can never succeed.
      return Response.json({ error: "billing not configured" }, { status: 503 });
    }
    return Response.json({ error: "webhook failed" }, { status: 500 });
  }

  if (!result.ok) {
    // Permanent failures (forgery, unknown amount, workspace mismatch):
    // 400 so Stripe does not retry what can never succeed.
    // Transient failures: 500 so Stripe redelivers (idempotent on replay).
    const status = result.reason === "idempotency_read_failed" ? 500 : 400;
    return Response.json({ ok: false, reason: result.reason }, { status });
  }
  return Response.json({ ok: true, ignored: result.ignored ?? false, applied: result.applied ?? null });
}

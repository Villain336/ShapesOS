// ShapesOS — Phase 10 (finance): POST /api/ops/stripe/webhook/[workspaceId].
//
// PUBLIC BY DESIGN (capability model): Stripe calls this for the tenant's
// own Stripe account. Nothing is parsed or written before the
// Stripe-Signature header verifies against THAT workspace's webhook signing
// secret (stored with lib/secrets; stripe.webhooks.constructEvent, timestamp
// tolerance included) — no secret → 503, bad signature → 400. Only
// checkout.session.completed for an invoice of this workspace is acted on
// (Phase 10 store: plus storefront order sessions — paid / expired);
// the payment is applied once per payment intent (idempotent) and posted.
// Returns counts/ids only, never invoice data. 1 MiB body cap.

import { handleStripeWebhook } from "@/lib/ops/finance/stripe";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) return Response.json({ error: "Not found" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return Response.json({ error: "Payload too large" }, { status: 413 });
  try {
    const out = await handleStripeWebhook(workspaceId, raw, req.headers.get("stripe-signature"));
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    console.error(`[stripe-webhook] ${workspaceId}: ${(err as Error)?.name ?? "error"}`);
    // 500 → Stripe retries; the handler is idempotent.
    return Response.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

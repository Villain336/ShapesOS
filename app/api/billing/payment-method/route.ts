// Marketr — collect a card on file for overage invoices.
// POST /api/billing/payment-method { workspaceId } → { url }
// Admin-only (M11: requireWorkspaceAccess … "admin"). Creates a Stripe
// Checkout Session in `setup` mode bound to the workspace's Stripe Customer
// (created server-side on first use). Card data never touches Marketr —
// Stripe Checkout only. The signed checkout.session.completed webhook
// (mode=setup) attaches the card as the customer's default for invoices.
//
// The core is exported as createPaymentMethodForUser so the adversarial
// battery can exercise the real authorization path without an HTTP session.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { StripeBillingSink, BillingNotConfiguredError } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

/** Authorization-gated payment-method checkout core (unit-testable without a session). */
export async function createPaymentMethodForUser(args: {
  userId: string;
  workspaceId: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ status: number; body: unknown }> {
  const access = await requireWorkspaceAccess(args.userId, args.workspaceId, "admin");
  if ("error" in access && access.error) {
    const res: Response = access.error;
    let body: unknown = { error: "forbidden" };
    try {
      body = await res.json();
    } catch {
      /* keep default */
    }
    return { status: res.status, body };
  }
  const sink = new StripeBillingSink();
  try {
    const { url } = await sink.createPaymentMethodCheckout({
      workspaceId: access.workspaceId,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
    });
    return { status: 200, body: { url } };
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      return { status: 503, body: { error: e.message } };
    }
    return { status: 500, body: { error: "Failed to start card setup" } };
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { workspaceId?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON");
  }
  const origin = req.nextUrl.origin;
  const { status, body: out } = await createPaymentMethodForUser({
    userId: user.id,
    workspaceId: workspaceIdFrom(req, body),
    successUrl: `${origin}/dashboard/settings/usage?setup=success`,
    cancelUrl: `${origin}/dashboard/settings/usage?setup=cancelled`,
  });
  return Response.json(out, { status });
}

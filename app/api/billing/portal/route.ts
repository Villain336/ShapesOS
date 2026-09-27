// Marketr — Stripe Customer Portal session (Phase 13 Wave A).
// POST /api/billing/portal { workspaceId } → { url }
// Admin-only. The portal is the cancel/manage path: cancellation, card
// updates, and invoice history happen on Stripe's own UI; the signed
// customer.subscription.* webhooks sync the result back. 503 when Stripe
// keys are absent; 409 when the workspace has no Stripe customer yet.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { StripeBillingSink, BillingNotConfiguredError } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { workspaceId?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON");
  }
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;

  const sink = new StripeBillingSink();
  try {
    const { url } = await sink.createBillingPortalSession({
      workspaceId: access.workspaceId,
      returnUrl: `${req.nextUrl.origin}/dashboard/billing`,
    });
    return Response.json({ url });
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    if (e instanceof Error && /No Stripe customer/.test(e.message)) {
      return Response.json({ error: e.message }, { status: 409 });
    }
    return Response.json({ error: "Failed to open the billing portal" }, { status: 500 });
  }
}

// Marketr — plan subscription checkout + state (Phase 13 Wave A).
// GET /api/billing/subscription?workspaceId= → subscription state (plan,
//   subscription row, card-on-file, per-plan purchasability). Admin-only.
// POST /api/billing/subscription { workspaceId, planId, interval? } → { url }
//   Create a Stripe Checkout Session (mode=subscription) for the plan.
//   Phase 15.3: interval "month" (default) or "year" (annual, 2 months free).
//   Admin-only; the workspace is the authenticated admin's own. 503 when
//   Stripe keys are absent; 503 with a plain-language message when the plan
//   isn't linked to a Stripe Price yet.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import {
  StripeBillingSink,
  BillingNotConfiguredError,
  getSubscriptionState,
} from "@/lib/metering/billing";
import { isBillingInterval, planById } from "@/lib/billing/plans";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  return Response.json(await getSubscriptionState(access.workspaceId));
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let body: { planId?: unknown; workspaceId?: unknown; interval?: unknown } | null = null;
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid JSON");
  }
  const planId = typeof body?.planId === "string" ? body.planId : "";
  try {
    planById(planId);
  } catch {
    return badRequest("unknown plan");
  }
  const interval = body?.interval === undefined ? "month" : body.interval;
  if (!isBillingInterval(interval)) return badRequest('interval must be "month" or "year"');
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "admin");
  if ("error" in access) return access.error;

  const sink = new StripeBillingSink();
  const origin = req.nextUrl.origin;
  try {
    const { url } = await sink.createSubscriptionCheckout({
      workspaceId: access.workspaceId,
      planId,
      interval,
      successUrl: `${origin}/dashboard/billing?sub=success`,
      cancelUrl: `${origin}/dashboard/billing?sub=cancelled`,
    });
    return Response.json({ url });
  } catch (e) {
    if (e instanceof BillingNotConfiguredError) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    // Plan not linked to a Stripe Price: honest, actionable, still a 503 —
    // billing exists but this plan isn't purchasable on this deployment.
    if (e instanceof Error && /isn't linked to a Stripe price/.test(e.message)) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    return Response.json({ error: "Failed to create subscription checkout" }, { status: 500 });
  }
}

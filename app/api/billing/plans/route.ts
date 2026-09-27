// Marketr — plan catalogue for the billing hub (Phase 13 Wave A).
// GET /api/billing/plans?workspaceId= → { configured, currentPlan, plans }
// Admin-only. Never exposes Stripe Price ids — only whether each plan is
// purchasable on this deployment.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import { getSubscriptionState } from "@/lib/metering/billing";
import {
  PLANS,
  includedCreditsForBillingPlan,
  planPriceDisplay,
  stripePriceIdFor,
} from "@/lib/billing/plans";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  const state = await getSubscriptionState(access.workspaceId);
  return Response.json({
    configured: state.configured,
    currentPlan: state.plan,
    plans: PLANS.map((p) => ({
      id: p.id,
      name: p.name,
      tagline: p.tagline,
      priceDisplay: planPriceDisplay(p),
      priceCents: p.priceCents,
      includedCredits: includedCreditsForBillingPlan(p.id),
      features: p.features,
      badge: p.badge ?? null,
      purchasable: stripePriceIdFor(p) !== null,
    })),
  });
}

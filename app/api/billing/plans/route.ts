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
  extraSeatPriceCents,
  includedCreditsForBillingPlan,
  planOffer,
  planPriceCents,
  planPriceDisplay,
  stripePriceIdFor,
  stripeSeatPriceIdFor,
} from "@/lib/billing/plans";

export const dynamic = "force-dynamic";

// Phase 15.3: base fee + seats + credits. Every number comes from the plan
// constants (lib/billing/plans.ts planOffer); purchasability is per interval.
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;
  const state = await getSubscriptionState(access.workspaceId);
  return Response.json({
    configured: state.configured,
    currentPlan: state.plan,
    currentInterval: state.subscription?.interval ?? null,
    plans: PLANS.map((p) => {
      const offer = planOffer(p.id);
      return {
        id: p.id,
        name: p.name,
        tagline: p.tagline,
        priceDisplay: planPriceDisplay(p),
        priceCents: p.priceCents,
        annualPriceDisplay: planPriceDisplay(p, "year"),
        annualPriceCents: planPriceCents(p, "year"),
        includedCredits: includedCreditsForBillingPlan(p.id),
        includedSeats: offer.includedSeats,
        extraSeatCents: extraSeatPriceCents(p, "month"),
        extraSeatAnnualCents: extraSeatPriceCents(p, "year"),
        workspaces: offer.workspaces,
        features: offer.lines,
        badge: p.badge ?? null,
        purchasable: stripePriceIdFor(p) !== null,
        purchasableAnnual: stripePriceIdFor(p, "year") !== null,
        seatsPurchasable: stripeSeatPriceIdFor(p) !== null,
        seatsPurchasableAnnual: stripeSeatPriceIdFor(p, "year") !== null,
      };
    }),
  });
}

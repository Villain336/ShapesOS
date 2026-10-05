// ShapesOS — Phase 15.3 pricing: the plan tables agree with each other and
// with the owner's numbers, and every pricing surface derives from them.
// Pure: no database, no Stripe.
// Run: npx tsx --test lib/billing/__tests__/plans.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Plan } from "@prisma/client";
import {
  ANNUAL_BILLED_MONTHS,
  AGENCY_EXTRA_WORKSPACE_PRICE_CENTS,
  EXTRA_SEAT_PRICE_CENTS,
  PAID_PLAN_IDS,
  PLANS,
  PLAN_PRICE_CENTS,
  PRICING_ORDER,
  extraSeatMonthlyCentsFor,
  extraSeatPriceCents,
  formatUsd,
  isSeatStripePrice,
  planById,
  planConsistencyProblems,
  planForStripePrice,
  planIdForStripePrice,
  planOffer,
  planPriceCents,
  pricingCatalog,
  stripePriceIdFor,
  stripeSeatPriceIdFor,
} from "../plans";
import {
  FEATURES,
  INCLUDED_SEATS,
  PLAN_ENTITLEMENTS,
  TWIN_SITE_LIMITS,
  WORKSPACE_LIMITS,
  planHasFeature,
} from "../entitlements";
import {
  BASE_INCLUDED_CREDITS,
  INCLUDED_CREDITS_MULTIPLIER,
  TIER_INCLUDED_CREDITS,
  TRIAL_INCLUDED_CREDITS,
} from "@/lib/metering/credits";
import { TRIAL_DAYS } from "../trial";

const ALL_PLANS: Plan[] = ["self_hosted", "trial", "starter", "pro", "business", "agency"];

describe("plan tables are consistent", () => {
  it("the boot-time consistency check finds no problems", () => {
    assert.deepEqual(planConsistencyProblems(), []);
  });

  it("every plan has entitlements and a credit pool; every paid plan has prices, seats and a pool", () => {
    for (const plan of ALL_PLANS) {
      assert.ok(PLAN_ENTITLEMENTS[plan], `${plan} entitlements`);
      assert.equal(typeof TIER_INCLUDED_CREDITS[plan], "number", `${plan} credits`);
    }
    for (const id of PAID_PLAN_IDS) {
      const plan = planById(id);
      assert.ok(plan.priceCents > 0, `${id} base fee`);
      assert.ok(plan.extraSeatCents > 0, `${id} extra seat`);
      assert.ok((INCLUDED_SEATS[id] ?? 0) >= 1, `${id} included seats`);
      assert.ok(TIER_INCLUDED_CREDITS[id] > 0, `${id} pool`);
    }
    assert.deepEqual(PLANS.map((p) => p.id).sort(), [...PAID_PLAN_IDS].sort());
  });

  it("Business is present with its own numbers", () => {
    const b = planById("business");
    assert.equal(b.name, "Business");
    assert.equal(b.priceCents, 49_900);
    assert.equal(b.extraSeatCents, 1_500);
    assert.equal(INCLUDED_SEATS.business, 25);
    assert.equal(WORKSPACE_LIMITS.business, 10);
    assert.equal(TWIN_SITE_LIMITS.business, null);
    assert.equal(BASE_INCLUDED_CREDITS.business, 40_000);
    assert.equal(planHasFeature("business", "sso"), true);
    assert.equal(planHasFeature("business", "scim"), true);
    assert.equal(planHasFeature("business", "white_label"), false);
  });

  it("the numbers are the owner's (the plan table in 15.3)", () => {
    assert.deepEqual(PLAN_PRICE_CENTS, { starter: 5_900, pro: 19_900, business: 49_900, agency: 39_900 });
    assert.deepEqual(EXTRA_SEAT_PRICE_CENTS, { starter: 1_900, pro: 1_900, business: 1_500, agency: 1_900 });
    assert.deepEqual(INCLUDED_SEATS, { self_hosted: null, trial: 3, starter: 3, pro: 10, business: 25, agency: 5 });
    assert.deepEqual(WORKSPACE_LIMITS, { self_hosted: null, trial: 1, starter: 1, pro: 3, business: 10, agency: 25 });
    assert.deepEqual(BASE_INCLUDED_CREDITS, { starter: 4_000, pro: 15_000, business: 40_000, agency: 30_000 });
    assert.equal(TRIAL_INCLUDED_CREDITS, 1_000);
    assert.equal(TRIAL_DAYS, 14);
    assert.equal(AGENCY_EXTRA_WORKSPACE_PRICE_CENTS, 1_500);
    assert.equal(ANNUAL_BILLED_MONTHS, 10, "annual = 2 months free");
  });

  it("included credits = base × the one-line multiplier (Phase 17 knob)", () => {
    for (const id of PAID_PLAN_IDS) {
      assert.equal(TIER_INCLUDED_CREDITS[id], BASE_INCLUDED_CREDITS[id] * INCLUDED_CREDITS_MULTIPLIER, id);
    }
    assert.equal(TIER_INCLUDED_CREDITS.self_hosted, 0, "self-hosted = BYOK, no credits");
    assert.equal(TIER_INCLUDED_CREDITS.trial, TRIAL_INCLUDED_CREDITS, "the trial pool is not multiplied");
  });

  it("self_hosted keeps every feature with no limits; trial keeps Pro features", () => {
    for (const f of FEATURES) assert.equal(planHasFeature("self_hosted", f), true, f);
    for (const f of FEATURES) assert.equal(planHasFeature("trial", f), planHasFeature("pro", f), `trial ${f}`);
    for (const v of Object.values(PLAN_ENTITLEMENTS.self_hosted.limits)) assert.equal(v, null);
  });
});

describe("annual prices and Stripe price ids", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("STRIPE_PRICE_")) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (k.startsWith("STRIPE_PRICE_")) process.env[k] = v;
  });

  it("annual is ANNUAL_BILLED_MONTHS × monthly, for the base fee and the seat", () => {
    for (const plan of PLANS) {
      assert.equal(planPriceCents(plan, "year"), plan.priceCents * ANNUAL_BILLED_MONTHS);
      assert.equal(extraSeatPriceCents(plan, "year"), plan.extraSeatCents * ANNUAL_BILLED_MONTHS);
    }
  });

  it("env names follow STRIPE_PRICE_<PLAN>[_ANNUAL] and STRIPE_PRICE_SEAT_<PLAN>[_ANNUAL]", () => {
    for (const plan of PLANS) {
      const up = plan.id.toUpperCase();
      assert.equal(plan.stripePriceEnv, `STRIPE_PRICE_${up}`);
      assert.equal(plan.stripeAnnualPriceEnv, `STRIPE_PRICE_${up}_ANNUAL`);
      assert.equal(plan.stripeSeatPriceEnv, `STRIPE_PRICE_SEAT_${up}`);
      assert.equal(plan.stripeSeatAnnualPriceEnv, `STRIPE_PRICE_SEAT_${up}_ANNUAL`);
    }
  });

  it("price ids resolve per interval; seats are never mistaken for a plan", () => {
    process.env.STRIPE_PRICE_BUSINESS = "price_biz_m";
    process.env.STRIPE_PRICE_BUSINESS_ANNUAL = "price_biz_y";
    process.env.STRIPE_PRICE_SEAT_BUSINESS = "price_seat_biz_m";
    process.env.STRIPE_PRICE_SEAT_BUSINESS_ANNUAL = "not-a-price-id";
    const biz = planById("business");
    assert.equal(stripePriceIdFor(biz, "month"), "price_biz_m");
    assert.equal(stripePriceIdFor(biz, "year"), "price_biz_y");
    assert.equal(stripeSeatPriceIdFor(biz, "month"), "price_seat_biz_m");
    assert.equal(stripeSeatPriceIdFor(biz, "year"), null, "a malformed id is treated as unset");
    assert.deepEqual(planForStripePrice("price_biz_y"), { planId: "business", interval: "year" });
    assert.equal(planIdForStripePrice("price_biz_m"), "business");
    assert.equal(planIdForStripePrice("price_seat_biz_m"), null);
    assert.equal(isSeatStripePrice("price_seat_biz_m"), true);
    assert.equal(isSeatStripePrice("price_biz_m"), false);
  });

  it("only paid plans can buy extra seats", () => {
    assert.equal(extraSeatMonthlyCentsFor("self_hosted"), null);
    assert.equal(extraSeatMonthlyCentsFor("trial"), null);
    assert.equal(extraSeatMonthlyCentsFor("business"), EXTRA_SEAT_PRICE_CENTS.business);
  });
});

describe("pricing page data derives from the constants", () => {
  it("each paid offer shows the constants, formatted", () => {
    for (const id of PAID_PLAN_IDS) {
      const o = planOffer(id);
      assert.equal(o.monthlyCents, PLAN_PRICE_CENTS[id]);
      assert.equal(o.annualCents, PLAN_PRICE_CENTS[id] * ANNUAL_BILLED_MONTHS);
      assert.equal(o.includedSeats, INCLUDED_SEATS[id]);
      assert.equal(o.extraSeatCents, EXTRA_SEAT_PRICE_CENTS[id]);
      assert.equal(o.includedCredits, TIER_INCLUDED_CREDITS[id]);
      const text = o.lines.join(" | ");
      assert.ok(text.includes(`${INCLUDED_SEATS[id]} seats included`), `${id}: ${text}`);
      assert.ok(text.includes(`${formatUsd(EXTRA_SEAT_PRICE_CENTS[id])} / month each`), `${id}: ${text}`);
      assert.ok(text.includes(`${TIER_INCLUDED_CREDITS[id].toLocaleString("en-US")} AI credits / month`), `${id}: ${text}`);
    }
    assert.match(planOffer("agency").lines.join(" "), /pooled/);
    assert.match(planOffer("agency").lines.join(" "), /25 client workspaces \(\+\$15 each extra\)/);
    assert.match(planOffer("pro").lines.join(" "), /Digital twin, 3 sites/);
  });

  it("trial and self-hosted offers come from the same constants", () => {
    const t = planOffer("trial");
    assert.equal(t.monthlyCents, null);
    assert.equal(t.priceNote, `${TRIAL_DAYS} days free`);
    assert.equal(t.includedCredits, TRIAL_INCLUDED_CREDITS);
    assert.ok(t.lines.includes(`${INCLUDED_SEATS.trial} seats`));
    const s = planOffer("self_hosted");
    assert.equal(s.priceNote, "Free (AGPL)");
    assert.equal(s.includedCredits, 0);
    assert.match(s.lines.join(" "), /Bring your own/);
  });

  it("the catalog follows PRICING_ORDER and is serializable", () => {
    const c = pricingCatalog();
    assert.deepEqual(c.paid.map((o) => o.id), [...PRICING_ORDER]);
    assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
  });

  it("formats dollars", () => {
    assert.equal(formatUsd(5_900), "$59");
    assert.equal(formatUsd(499_000), "$4,990");
    assert.equal(formatUsd(1_250), "$12.50");
  });
});

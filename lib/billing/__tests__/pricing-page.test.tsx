// ShapesOS — Phase 15.3 pricing: the public /pricing page and the billing
// surfaces render server-side without throwing, and every number they show
// comes from the plan constants. No database, no browser.
// Run: npx tsx --test lib/billing/__tests__/pricing-page.test.tsx

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import PricingPage from "@/app/pricing/page";
import { PlanIncludes } from "@/components/billing/PlanIncludes";
import BillingHub from "@/components/settings/BillingHub";
import { PAID_PLAN_IDS, PLAN_PRICE_CENTS, ANNUAL_BILLED_MONTHS, formatUsd, pricingPageData } from "../plans";
import { INCLUDED_SEATS } from "../entitlements";
import { TIER_INCLUDED_CREDITS, TRIAL_INCLUDED_CREDITS, CREDIT_COSTS } from "@/lib/metering/credits";

// React escapes text; compare against the escaped form.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("/pricing (server render)", () => {
  const html = renderToStaticMarkup(<PricingPage />);

  it("renders every plan card, including trial and self-hosted", () => {
    for (const id of [...PAID_PLAN_IDS, "trial", "self_hosted"]) assert.ok(html.includes(`data-plan="${id}"`), id);
    assert.match(html, /<h1[^>]*>Simple pricing/);
  });

  it("shows the constants: monthly prices, seats, credit pools, trial pool", () => {
    for (const id of PAID_PLAN_IDS) {
      assert.ok(html.includes(formatUsd(PLAN_PRICE_CENTS[id])), `${id} price`);
      assert.ok(html.includes(formatUsd(PLAN_PRICE_CENTS[id] * ANNUAL_BILLED_MONTHS)), `${id} annual price`);
      assert.ok(html.includes(`${INCLUDED_SEATS[id]} seats included`), `${id} seats`);
      assert.ok(html.includes(`${TIER_INCLUDED_CREDITS[id].toLocaleString("en-US")} AI credits / month`), `${id} credits`);
    }
    assert.ok(html.includes(`${TRIAL_INCLUDED_CREDITS.toLocaleString("en-US")} AI credits, one time`));
    assert.ok(html.includes(esc("Free (AGPL)")));
    assert.ok(html.includes(`<td class="py-2 text-ink">${CREDIT_COSTS.keyword_research.credits}</td>`));
  });

  it("matches pricingPageData exactly (no number typed on the page)", () => {
    const data = pricingPageData();
    for (const o of [...data.paid, data.trial, data.selfHosted]) {
      for (const line of o.lines) assert.ok(html.includes(esc(line)), line);
    }
  });

  it("follows the design law: tokens only, no Tailwind default palette, no raw hex", () => {
    assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(html, /\b(?:bg|text|border|ring)-(?:red|blue|green|yellow|gray|slate|zinc|neutral|stone|violet|teal|emerald|indigo)-\d{2,3}\b/);
    assert.doesNotMatch(html, /gradient/);
  });
});

describe("billing surfaces (server render)", () => {
  it("PlanIncludes renders the Business column and the new features", () => {
    const html = renderToStaticMarkup(<PlanIncludes plan="business" planName="Business" />);
    assert.match(html, /Business \(yours\)/);
    for (const label of ["Digital twin", "Payroll", "Point of sale", "Twin sites"]) assert.ok(html.includes(label), label);
  });

  it("BillingHub renders its loading state without throwing", () => {
    const html = renderToStaticMarkup(<BillingHub workspaceId="ws_test" />);
    assert.match(html, /Billing &amp; plans/);
    assert.match(html, /Loading billing/);
  });
});

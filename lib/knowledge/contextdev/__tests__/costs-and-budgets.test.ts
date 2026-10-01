// Marketr — Wave 2 context.dev slice 1 tests: credit costs + budget gate.
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/costs.test.ts
//      npx tsx --test lib/knowledge/contextdev/__tests__/budgets.test.ts
//
// Pure: no database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contextDevCreditsFor,
  knownContextDevOperations,
  CONTEXTDEV_CREDIT_COSTS,
} from "../costs";
import { decideBudget, DEFAULT_DAILY_CAP_CREDITS } from "../budgets";

describe("contextDevCreditsFor", () => {
  it("returns the verified per-operation costs", () => {
    assert.equal(contextDevCreditsFor("scrape_markdown"), 1);
    assert.equal(contextDevCreditsFor("scrape_html"), 1);
    assert.equal(contextDevCreditsFor("scrape_images"), 1);
    assert.equal(contextDevCreditsFor("crawl_sitemap"), 1);
    assert.equal(contextDevCreditsFor("brand_retrieve"), 10);
    assert.equal(contextDevCreditsFor("brand_prefetch"), 0);
    assert.equal(contextDevCreditsFor("ai_products"), 10);
  });

  it("fails closed on unknown operations", () => {
    assert.throws(() => contextDevCreditsFor("scrape_everything"), /unknown operation/);
    assert.throws(() => contextDevCreditsFor(""), /unknown operation/);
  });

  it("knownContextDevOperations lists every priced operation", () => {
    const ops = knownContextDevOperations();
    assert.equal(ops.length, Object.keys(CONTEXTDEV_CREDIT_COSTS).length);
    assert.ok(ops.includes("brand_prefetch"));
  });
});

describe("decideBudget", () => {
  it("allows a call that fits inside the budget", () => {
    const v = decideBudget({ usedToday: 20, capCredits: 100 }, 10);
    assert.equal(v.decision, "allow");
    assert.equal(v.remainingAfter, 70);
  });

  it("allows a call that exactly exhausts the budget", () => {
    const v = decideBudget({ usedToday: 90, capCredits: 100 }, 10);
    assert.equal(v.decision, "allow");
    assert.equal(v.remainingAfter, 0);
  });

  it("routes over-budget calls to approval, never failing silently", () => {
    const v = decideBudget({ usedToday: 95, capCredits: 100 }, 10);
    assert.equal(v.decision, "needs_approval");
    assert.ok(v.reason.includes("approval required"));
    assert.equal(v.remainingAfter, 5);
  });

  it("treats a zero/negative cap as no budget configured → approval", () => {
    assert.equal(decideBudget({ usedToday: 0, capCredits: 0 }, 1).decision, "needs_approval");
    assert.equal(decideBudget({ usedToday: 0, capCredits: -5 }, 1).decision, "needs_approval");
  });

  it("fails closed on invalid numbers", () => {
    assert.equal(decideBudget({ usedToday: NaN, capCredits: 100 }, 1).decision, "needs_approval");
    assert.equal(decideBudget({ usedToday: -1, capCredits: 100 }, 1).decision, "needs_approval");
    assert.equal(decideBudget({ usedToday: 0, capCredits: 100 }, -1).decision, "needs_approval");
    assert.equal(decideBudget({ usedToday: 0, capCredits: Infinity }, 1).decision, "needs_approval");
  });

  it("default daily cap is a positive integer", () => {
    assert.ok(Number.isInteger(DEFAULT_DAILY_CAP_CREDITS) && DEFAULT_DAILY_CAP_CREDITS > 0);
  });
});

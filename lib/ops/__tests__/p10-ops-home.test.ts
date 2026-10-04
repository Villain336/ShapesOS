// ShapesOS Phase 10 (ops-core): ops home sections, legacy CRM redirects,
// promotion evaluation. Unit (no DB).
// Run: npx tsx --test lib/ops/__tests__/p10-ops-home.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { OPS_SECTIONS, legacyCrmRedirect } from "../sections";
import { evaluatePromotion, parsePromotionRules } from "../promotions";

describe("ops home sections", () => {
  it("every ops-core section has a page; finance sections are links only", () => {
    for (const s of OPS_SECTIONS) {
      const file = s.slug ? `app/dashboard/ops/${s.slug}/page.tsx` : "app/dashboard/ops/page.tsx";
      // Phase 12 (mfgpos): its sections ship their pages too.
      if (s.owner === "opscore" || s.owner === "mfgpos") assert.ok(existsSync(file), `${file} missing`);
      assert.ok(s.href.startsWith("/dashboard/ops"));
    }
    const slugs = OPS_SECTIONS.map((s) => s.slug);
    assert.equal(new Set(slugs).size, slugs.length, "duplicate section slug");
    for (const f of ["accounting", "quotes", "vendors", "expenses"]) assert.ok(slugs.includes(f));
  });

  it("redirects old CRM ops tabs and keeps the rest of the query", () => {
    assert.equal(legacyCrmRedirect({ tab: "invoicing", invoice: "inv_1" }), "/dashboard/ops/invoices?invoice=inv_1");
    assert.equal(legacyCrmRedirect({ tab: "purchase-orders" }), "/dashboard/ops/purchasing");
    assert.equal(legacyCrmRedirect({ tab: "projects" }), "/dashboard/ops/projects");
    assert.equal(legacyCrmRedirect({ tab: "pipeline" }), null, "CRM tabs stay in the CRM");
    assert.equal(legacyCrmRedirect({ lead: "l1" }), null);
  });
});

describe("promotion evaluation", () => {
  const base = { code: "X", active: true, usageLimit: null, usedCount: 0 };

  it("percent and amount off, capped at the eligible subtotal", () => {
    const v = evaluatePromotion({ ...base, rules: { percentOff: 20 } }, [{ qty: 2, priceCents: 5000 }]);
    assert.deepEqual(v, { ok: true, discountCents: 2000, eligibleSubtotalCents: 10000 });
    const cap = evaluatePromotion({ ...base, rules: { amountOffCents: 99999 } }, [{ qty: 1, priceCents: 500 }]);
    assert.equal(cap.ok && cap.discountCents, 500);
  });

  it("refuses inactive, exhausted, below-minimum and ineligible orders", () => {
    assert.equal(evaluatePromotion({ ...base, active: false, rules: { percentOff: 10 } }, [{ qty: 1, priceCents: 100 }]).ok, false);
    assert.equal(evaluatePromotion({ ...base, usageLimit: 3, usedCount: 3, rules: { percentOff: 10 } }, [{ qty: 1, priceCents: 100 }]).ok, false);
    assert.equal(evaluatePromotion({ ...base, rules: { percentOff: 10, minSubtotalCents: 1000 } }, [{ qty: 1, priceCents: 100 }]).ok, false);
    const sku = evaluatePromotion({ ...base, rules: { percentOff: 50, productSkus: ["A"] } }, [
      { sku: "A", qty: 1, priceCents: 1000 },
      { sku: "B", qty: 1, priceCents: 1000 },
    ]);
    assert.equal(sku.ok && sku.discountCents, 500);
  });

  it("ignores junk rule values", () => {
    assert.deepEqual(parsePromotionRules({ percentOff: -5, amountOffCents: "9", productSkus: [1, "Z"] }), { productSkus: ["Z"] });
    assert.equal(evaluatePromotion({ ...base, rules: {} }, [{ qty: 1, priceCents: 100 }]).ok, false);
  });
});

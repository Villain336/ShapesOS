// Marketr — Dataset Builder slice 2 tests: classifier accuracy per type.
// Run: npx tsx --test lib/datasetbuilder/__tests__/classify.test.ts
//
// The deterministic rules engine is the default classifier. Each sample
// below is a realistic chunk a business might ingest; every one must land
// in the right type with confidence at or above the auto-apply threshold.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DATASET_TYPES,
  DEFAULT_CLASSIFICATION_THRESHOLD,
  FrontierClassificationEngine,
  RulesClassificationEngine,
  type DatasetType,
} from "../classify";

const engine = new RulesClassificationEngine();

const SAMPLES: Array<{ type: DatasetType; text: string }> = [
  {
    type: "faq",
    text: "Q: How do I reset my password? A: Click the forgot-password link on the sign-in page and follow the emailed instructions. Q: Can I change my plan mid-cycle? A: Yes, changes take effect at the next billing date.",
  },
  {
    type: "faq",
    text: "Frequently asked questions about delivery. How long does shipping take? Standard delivery takes 3 to 5 business days. What is your return policy? You can return items within 30 days.",
  },
  {
    type: "product_catalog",
    text: "Pro Widget 3000, SKU WDG-3000. Dimensions 12 x 8 x 4 inches, weight 2.3 lbs. In stock. Features: stainless housing, 5-year warranty, color options black and silver. Specifications: 110V input, 400W output.",
  },
  {
    type: "product_catalog",
    text: "Model number DRN-X2 quadcopter. Specs: 4K camera, 34-minute flight time, 10km range. In stock and shipping now. Color options: graphite and arctic white.",
  },
  {
    type: "policy",
    text: "Refund policy. All refund requests must be submitted within 30 days of purchase. We reserve the right to deny requests that violate these terms. Misuse of discount codes is prohibited and may result in account suspension.",
  },
  {
    type: "policy",
    text: "Privacy policy, effective date January 1, 2026. We collect only the data required to operate your account. Data is never sold. Requests for deletion shall be honored within 30 days in compliance with applicable law.",
  },
  {
    type: "process_sop",
    text: "Onboarding procedure. Step 1: create the client workspace. Step 2: invite the team. Step 3: import existing assets. Step 4: run the brand audit checklist. Finally, schedule the kickoff call.",
  },
  {
    type: "process_sop",
    text: "Incident response SOP. First, acknowledge the alert within 5 minutes. Then, isolate the affected service. Next, notify the on-call lead. After that, follow the rollback workflow and document every step.",
  },
  {
    type: "company_fact",
    text: "Acme Studio was founded in 2019 and is headquartered in Raleigh, North Carolina. Our mission is to make marketing accessible to small teams. We are a team of 24 employees led by CEO Tico Hamphill.",
  },
  {
    type: "company_fact",
    text: "About us: Brightline Logistics has operated since 2012 with 140 employees across three offices. Founded by Maria Chen, the company runs the largest independent freight network in the Southeast.",
  },
  {
    type: "pricing",
    text: "Starter plan: $29 per month billed annually. Growth plan: $79 per month. Scale plan: $199 per month. All plans include a 14-day free trial and one-time onboarding is $499.",
  },
  {
    type: "pricing",
    text: "Enterprise pricing is custom. The professional tier costs $149/mo per seat with volume discounts above 50 seats. Annual billing saves 20% versus monthly.",
  },
];

describe("rules classifier accuracy", () => {
  for (const sample of SAMPLES) {
    it(`classifies ${sample.type}: "${sample.text.slice(0, 40)}…"`, async () => {
      const out = await engine.classify(sample.text);
      assert.equal(out.type, sample.type, `expected ${sample.type}, got ${out.type}`);
      assert.ok(
        out.confidence >= DEFAULT_CLASSIFICATION_THRESHOLD,
        `confidence ${out.confidence} below threshold ${DEFAULT_CLASSIFICATION_THRESHOLD}`,
      );
    });
  }

  it("covers all six dataset types", () => {
    assert.deepEqual([...DATASET_TYPES].sort(), [
      "company_fact",
      "faq",
      "policy",
      "pricing",
      "process_sop",
      "product_catalog",
    ]);
  });
});

describe("rules classifier low-confidence routing", () => {
  it("routes ambiguous text below the threshold (never force-fits)", async () => {
    // Price mention inside a policy sentence: two types compete.
    const out = await engine.classify(
      "Policy update: the monthly fee is $40 and late payment is prohibited under section 4 of our terms.",
    );
    assert.ok(
      out.confidence < DEFAULT_CLASSIFICATION_THRESHOLD,
      `ambiguous text should not clear the threshold, got ${out.confidence}`,
    );
  });

  it("routes empty text below the threshold", async () => {
    const out = await engine.classify("   ");
    assert.ok(out.confidence < DEFAULT_CLASSIFICATION_THRESHOLD);
  });

  it("confidence is always within 0–1", async () => {
    for (const sample of SAMPLES) {
      const out = await engine.classify(sample.text);
      assert.ok(out.confidence >= 0 && out.confidence <= 1);
    }
  });
});

describe("frontier classification engine", () => {
  it("fails closed without a key", async () => {
    const frontier = new FrontierClassificationEngine();
    await assert.rejects(() => frontier.classify("hello"), /not configured/);
  });
});

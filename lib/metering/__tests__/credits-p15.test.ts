// ShapesOS Phase 15.2 — the credit rules (pure, no DB).
// Run: npx tsx --test lib/metering/__tests__/credits-p15.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CREDIT_CATEGORIES,
  CREDIT_COSTS,
  CREDIT_TABLE_VERSION,
  INTELLIGENCE_VENDOR_MULTIPLIER,
  LLM_TOKEN_COST_MULTIPLIER,
  categoryOf,
  creditsFor,
  llmTokenCredits,
  vendorUsdCredits,
} from "../credits";
import { llmCallCharge } from "@/lib/llm/usage";
import { MODEL_PRICES, fallbackPrice } from "@/lib/llm/pricing";

const u = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("model token credits: ceil(cost × 100 × 1.5)", () => {
  it("is 1.5× provider cost at 1 credit = $0.01, a named constant", () => {
    assert.equal(LLM_TOKEN_COST_MULTIPLIER, 1.5);
    assert.equal(llmTokenCredits(1_000_000), 150, "$1.00 of tokens → 150 credits");
    assert.equal(llmTokenCredits(3_000_000), 450, "a ~$3 coding task → 450 credits (pricing plan)");
    assert.equal(llmTokenCredits(10_000), 2, "$0.01 → 1.5 → rounds UP to 2");
  });

  it("rounds up, never down; zero cost is zero", () => {
    assert.equal(llmTokenCredits(0), 0);
    assert.equal(llmTokenCredits(1), 1, "any positive cost costs at least 1 credit");
    assert.equal(llmTokenCredits(6_666), 1); // 0.99999
    assert.equal(llmTokenCredits(6_667), 2); // 1.00005
    assert.equal(llmTokenCredits(-5), 0);
    assert.equal(llmTokenCredits(Number.NaN), 0);
  });

  it("an unknown model is charged at the most expensive known rates — never 0", () => {
    const unknown = llmCallCharge({ model: "brand-new-model-x", usage: u(10_000, 2_000) });
    const fable = llmCallCharge({ model: "claude-fable-5-1", usage: u(10_000, 2_000) });
    assert.equal(unknown.priced, false);
    assert.ok(unknown.credits > 0);
    assert.ok(unknown.credits >= fable.credits, "at least what the dearest model costs");
    const fb = fallbackPrice();
    assert.equal(unknown.credits, llmTokenCredits(10_000 * fb.input + 2_000 * fb.output));
    for (const p of Object.values(MODEL_PRICES)) assert.ok(fb.output >= (p.output ?? 0));
  });

  it("a BYOK (workspace key) call is 0 credits and records what it saved; a local model is 0", () => {
    const platform = llmCallCharge({ model: "claude-opus-5-5", usage: u(1000, 200, 5000, 400) });
    const byok = llmCallCharge({ model: "claude-opus-5-5", usage: u(1000, 200, 5000, 400), keySource: "workspace" });
    const local = llmCallCharge({ model: "qwen3-local", usage: u(1000, 200), keySource: "self_host" });
    assert.deepEqual([platform.credits, platform.waivedCredits], [2, 0]);
    assert.deepEqual([byok.credits, byok.waivedCredits], [0, 2]);
    assert.deepEqual([local.credits, local.waivedCredits], [0, 0]);
  });

  it("a call inside a value-priced action is recorded at 0 (the action charges the work)", () => {
    const r = llmCallCharge({ model: "claude-opus-5-5", usage: u(1000, 200), billing: "included" });
    assert.deepEqual([r.credits, r.waivedCredits], [0, 0]);
  });
});

describe("vendor USD → credits", () => {
  it("intelligence vendor calls are 4× their USD cost, rounded up", () => {
    assert.equal(INTELLIGENCE_VENDOR_MULTIPLIER, 4);
    assert.equal(vendorUsdCredits(0.07), 28, "float noise never rounds a whole number up");
    assert.equal(vendorUsdCredits(0.001), 1);
    assert.equal(vendorUsdCredits(0.0006), 1);
    assert.equal(vendorUsdCredits(0), 0);
    assert.equal(vendorUsdCredits(1.5, 2), 300, "direct mail at 2×");
  });
});

describe("credit table v3", () => {
  it("bumped the version for the cost changes", () => {
    assert.equal(CREDIT_TABLE_VERSION, 3);
  });

  it("every action has a category (AI, data, messaging, compute or other)", () => {
    for (const [action, def] of Object.entries(CREDIT_COSTS)) {
      const cat = (def as { category?: string }).category;
      assert.ok(cat && (CREDIT_CATEGORIES as readonly string[]).includes(cat), `${action} has no category`);
    }
    assert.equal(categoryOf("llm_tokens"), "ai");
    assert.equal(categoryOf("sandbox_minute"), "compute");
    assert.equal(categoryOf("call_minute"), "messaging");
    assert.equal(categoryOf("intelligence_vendor_call"), "data");
    assert.equal(categoryOf("not-an-action"), "other");
  });

  it("each new paid metered action has a positive price", () => {
    for (const a of [
      "llm_tokens",
      "sandbox_minute",
      "call_minute",
      "call_transcription_minute",
      "phone_number_month",
      "intelligence_vendor_call",
      "geo_prompt_run",
    ]) {
      assert.ok(creditsFor(a) > 0, a);
      assert.equal((CREDIT_COSTS as Record<string, { basis: string }>)[a].basis, "cost-plus", a);
    }
  });

  it("penpot_import is in the table (it was missing → every import charge was refused) and free by design", () => {
    assert.equal(creditsFor("penpot_import"), 0);
    assert.equal(CREDIT_COSTS.penpot_import.basis, "free");
  });
});
